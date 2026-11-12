<?php
// Read-only questions about plan.json used by the master-data rules (R3, R4) and the drivers list:
// which stop lists dated on or after today hold a customer, and the R8 effective stop list of a job.
// Pure functions of (plan, today).
final class Usage
{
    /** The waste type of a route record stored before routes had one. */
    public const DEFAULT_ROUTE_TYPE = 'REL';

    /** The one waste type a route collects. */
    public static function routeType(array $route): string
    {
        return (string) ($route['waste_type'] ?? self::DEFAULT_ROUTE_TYPE);
    }

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

    /**
     * route id => series id. A "following" save (R12) or a schedule change (R14) ends a recurring route at
     * D - 1 and continues it as a new record from D; to the office the records are ONE route, linked by the
     * `series` the split writes (the id of the route's first record). A route created by POST starts its own
     * series, so a new route that reuses an ended route's code is never part of it. A one-off is its own series.
     * A record without `series` (stored before it existed, or written by the seed) is its own series: membership
     * is never guessed from code and dates, because "End route" followed by a new route with the same code looks
     * exactly like a split.
     * @return array<int,int>
     */
    public static function seriesMap(array $plan): array
    {
        $map = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $id = (int) $r['id'];
            $map[$id] = (!self::isOneOff($r) && isset($r['series'])) ? (int) $r['series'] : $id;
        }
        return $map;
    }

    /**
     * The real period of every series as the office sees it: series id => [first start, last end or null].
     * @param array<int,int>|null $map seriesMap($plan)
     * @return array<int,array{0:string,1:?string}>
     */
    public static function seriesPeriods(array $plan, ?array $map = null): array
    {
        $map ??= self::seriesMap($plan);
        $out = [];
        foreach ($plan['routes'] ?? [] as $r) {
            if (self::isOneOff($r)) {
                continue;
            }
            $sid = $map[(int) $r['id']];
            $end = $r['end'] ?? null;
            if (!isset($out[$sid])) {
                $out[$sid] = [(string) $r['start'], $end];
                continue;
            }
            [$s, $e] = $out[$sid];
            $out[$sid] = [min($s, (string) $r['start']), ($e === null || $end === null) ? null : max($e, $end)];
        }
        return $out;
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
     * recurring routes, one-off routes dated >= today, and override lists dated >= today. With $wasteTypes,
     * only the routes that collect one of those types.
     * @return list<array{kind:string,route_id:int,code:string,name:string,type:string,where:string,date:?string}>
     */
    public static function routeStops(array $plan, int $cid, string $today, ?array $wasteTypes = null): array
    {
        $out = [];
        $byId = [];
        $map = self::seriesMap($plan);
        foreach ($plan['routes'] ?? [] as $r) {
            if ($wasteTypes !== null && !in_array(self::routeType($r), $wasteTypes, true)) {
                continue;
            }
            $byId[$r['id']] = $r;
            if (self::routeLive($r, $today) && self::stopsHave($r['stops'] ?? [], $cid)) {
                $oneOff = self::isOneOff($r);
                $out[] = self::routeRef($r, $oneOff ? 'one-off' : 'template', $oneOff ? $r['date'] : null, $map);
            }
        }
        foreach ($plan['route_overrides'] ?? [] as $o) {
            $r = $byId[$o['route_id']] ?? null;
            if ($r !== null && $o['date'] >= $today && is_array($o['stops'] ?? null) && self::stopsHave($o['stops'], $cid)) {
                $out[] = self::routeRef($r, 'override', $o['date'], $map);
            }
        }
        return $out;
    }

    /** "series" groups the records of one split route (seriesMap): callers list such a route once. */
    private static function routeRef(array $r, string $where, ?string $date, array $map): array
    {
        return ['kind' => 'route', 'route_id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '',
            'type' => $r['type'], 'waste_type' => self::routeType($r), 'where' => $where, 'date' => $date, 'series' => $map[(int) $r['id']] ?? (int) $r['id']];
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

    /**
     * R8 effective stop customer ids of a job on a date, from the live plan:
     * override(d).stops ?? route.stops, minus inactive customers and customers without the route's waste
     * type. Unknown job (also a job of the old task feature): [].
     * @return list<int>
     */
    public static function jobStopIds(array $plan, string $date, string $job): array
    {
        $id = (int) substr($job, 1);
        $route = null;
        if (!str_starts_with($job, 'r')) {
            return [];
        }
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
        $customers = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $customers[$cu['id']] = $cu;
        }
        $ids = [];
        foreach ($stops as $s) {
            $cu = $customers[(int) $s['customer_id']] ?? null;
            if ($cu !== null && !empty($cu['active']) && in_array(self::routeType($route), $cu['waste_types'] ?? [], true)) {
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
