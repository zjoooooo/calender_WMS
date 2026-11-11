<?php
// Read-only questions about plan.json used by the master-data rules (R3, R4) and the drivers list:
// which stop lists dated on or after today hold a customer, which tasks still generate a date,
// and the R8 effective stop list of a job. Pure functions of (plan, today).
final class Usage
{
    public static function isOneOff(array $item): bool
    {
        return !empty($item['date']);
    }

    /** A route whose period reaches $today or later. */
    public static function routeLive(array $r, string $today): bool
    {
        if (self::isOneOff($r)) {
            return $r['date'] >= $today;
        }
        return ($r['end'] ?? null) === null || $r['end'] >= $today;
    }

    public static function stopsHave(array $stops, int $cid): bool
    {
        foreach ($stops as $s) {
            if ((int) ($s['customer_id'] ?? 0) === $cid) {
                return true;
            }
        }
        return false;
    }

    /** @return array<string,array> code => waste type */
    public static function typesByCode(array $plan): array
    {
        $out = [];
        foreach ($plan['waste_types'] ?? [] as $t) {
            $out[$t['code']] = $t;
        }
        return $out;
    }

    /** R4: a customer is routable when it has at least one ACTIVE routable type. */
    public static function customerRoutable(array $customer, array $typesByCode): bool
    {
        foreach ($customer['waste_types'] ?? [] as $code) {
            $t = $typesByCode[$code] ?? null;
            if ($t !== null && !empty($t['routable']) && !empty($t['active'])) {
                return true;
            }
        }
        return false;
    }

    /**
     * Every stop list dated on or after today that contains customer $cid: route templates of live
     * recurring routes, one-off routes dated >= today, and override lists dated >= today.
     * @return list<array{kind:string,route_id:int,code:string,name:string,type:string,where:string,date:?string}>
     */
    public static function routeStops(array $plan, int $cid, string $today): array
    {
        $out = [];
        $byId = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $byId[$r['id']] = $r;
            if (self::routeLive($r, $today) && self::stopsHave($r['stops'] ?? [], $cid)) {
                $oneOff = self::isOneOff($r);
                $out[] = self::routeRef($r, $oneOff ? 'one-off' : 'template', $oneOff ? $r['date'] : null);
            }
        }
        foreach ($plan['route_overrides'] ?? [] as $o) {
            $r = $byId[$o['route_id']] ?? null;
            if ($r !== null && $o['date'] >= $today && is_array($o['stops'] ?? null) && self::stopsHave($o['stops'], $cid)) {
                $out[] = self::routeRef($r, 'override', $o['date']);
            }
        }
        return $out;
    }

    private static function routeRef(array $r, string $where, ?string $date): array
    {
        return ['kind' => 'route', 'route_id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '',
            'type' => $r['type'], 'where' => $where, 'date' => $date];
    }

    /** customer_id => list of route codes whose stop lists dated >= today hold it (customer list endpoint). */
    public static function routeCodesByCustomer(array $plan, string $today): array
    {
        $byId = [];
        $out = [];
        $add = static function (int $cid, string $code) use (&$out): void {
            if (!in_array($code, $out[$cid] ?? [], true)) {
                $out[$cid][] = $code;
            }
        };
        foreach ($plan['routes'] ?? [] as $r) {
            $byId[$r['id']] = $r;
            if (self::routeLive($r, $today)) {
                foreach ($r['stops'] ?? [] as $s) {
                    $add((int) $s['customer_id'], $r['code']);
                }
            }
        }
        foreach ($plan['route_overrides'] ?? [] as $o) {
            $r = $byId[$o['route_id']] ?? null;
            if ($r !== null && $o['date'] >= $today && is_array($o['stops'] ?? null)) {
                foreach ($o['stops'] as $s) {
                    $add((int) $s['customer_id'], $r['code']);
                }
            }
        }
        foreach ($out as &$codes) {
            sort($codes, SORT_NATURAL);
        }
        return $out;
    }

    /** True when the task generates a date >= today (one-off: its date; recurring: a weekday in range). */
    public static function taskLive(array $t, string $today): bool
    {
        if (self::isOneOff($t)) {
            return $t['date'] >= $today;
        }
        $from = max((string) ($t['start'] ?? $today), $today);
        $end = $t['end'] ?? null;
        $days = $t['days'] ?? [];
        for ($i = 0; $i < 7; $i++) {
            $d = Dates::addDays($from, $i);
            if ($end !== null && $d > $end) {
                return false;
            }
            if (in_array(Dates::weekday($d), $days, true)) {
                return true;
            }
        }
        return false;
    }

    /** Live tasks (generating a date >= today) of a customer, optionally only of the given types. */
    public static function liveTasksOf(array $plan, int $cid, string $today, ?array $types = null): array
    {
        $out = [];
        foreach ($plan['tasks'] ?? [] as $t) {
            if ((int) $t['customer_id'] === $cid && ($types === null || in_array($t['waste_type'], $types, true))
                && self::taskLive($t, $today)) {
                $out[] = $t;
            }
        }
        return $out;
    }

    /** {"date"} or {"start","end","days"} of a task. */
    public static function taskSchedule(array $t): array
    {
        return self::isOneOff($t)
            ? ['date' => $t['date']]
            : ['start' => $t['start'] ?? null, 'end' => $t['end'] ?? null, 'days' => $t['days'] ?? []];
    }

    /**
     * R8 effective stop customer ids of a job on a date, from the live plan:
     * route: override(d).stops ?? route.stops, minus inactive or non-routable customers;
     * task: [task.customer_id]. Unknown job: [].
     * @return list<int>
     */
    public static function jobStopIds(array $plan, string $date, string $job): array
    {
        $id = (int) substr($job, 1);
        if (str_starts_with($job, 't')) {
            foreach ($plan['tasks'] ?? [] as $t) {
                if ($t['id'] === $id) {
                    return [(int) $t['customer_id']];
                }
            }
            return [];
        }
        $route = null;
        foreach ($plan['routes'] ?? [] as $r) {
            if ($r['id'] === $id) {
                $route = $r;
            }
        }
        if ($route === null) {
            return [];
        }
        $stops = $route['stops'] ?? [];
        if (!self::isOneOff($route)) {
            foreach ($plan['route_overrides'] ?? [] as $o) {
                if ($o['route_id'] === $id && $o['date'] === $date && is_array($o['stops'] ?? null)) {
                    $stops = $o['stops'];
                }
            }
        }
        $types = self::typesByCode($plan);
        $customers = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $customers[$cu['id']] = $cu;
        }
        $ids = [];
        foreach ($stops as $s) {
            $cu = $customers[(int) $s['customer_id']] ?? null;
            if ($cu !== null && !empty($cu['active']) && self::customerRoutable($cu, $types)) {
                $ids[] = (int) $s['customer_id'];
            }
        }
        return $ids;
    }

    /** Stop-list customers of the run with no collected or missed visit (R21). */
    public static function pendingCount(array $plan, string $date, string $job, array $run): int
    {
        $n = 0;
        foreach (self::jobStopIds($plan, $date, $job) as $cid) {
            $outcome = $run['visits'][$cid]['outcome'] ?? null;
            if ($outcome !== 'collected' && $outcome !== 'missed') {
                $n++;
            }
        }
        return $n;
    }
}
