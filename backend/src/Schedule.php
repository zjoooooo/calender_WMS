<?php
// Calendar logic (§5), pure functions of (plan, date):
//   R2 day class, R7 route generation, R8 effective stops, the §5.8 order inside
//   one day, and the R13 freeze snapshot (§4.7 "plan for a past date").
// The only impure function is freezeHook(), the before_request hook (order 10, src/hooks/10_freeze.php)
// that writes the frozen days and refuses requests whose clock is behind the freeze (CLOCK_BEHIND_FREEZE).
//
// Occurrence arrays built here are the PLAN side of RouteOccurrence (§4.8): no run
// overlay, no covered_by, no frozen flag. Calendar adds those.
final class Schedule
{
    /**
     * Lookup tables built once per plan (pass the result to the other functions when calling them in a loop).
     * @return array{holidays:array<string,string>,route_period:array<int,array{0:string,1:?string}>,customers:array<int,array>,types:array<string,array>,route_ov:array<string,array>,type_order:array<string,int>}
     */
    public static function index(array $plan): array
    {
        $customers = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $customers[(int) $cu['id']] = $cu;
        }
        $routeOv = [];
        foreach ($plan['route_overrides'] ?? [] as $o) {
            $routeOv[$o['route_id'] . '@' . $o['date']] = $o;
        }
        $types = Usage::typesByCode($plan);
        // R12/R14: the real period of a split route (first record's start, last record's end), per route id
        $series = Usage::seriesMap($plan);
        $periods = Usage::seriesPeriods($plan, $series);
        $routePeriod = [];
        foreach ($series as $id => $sid) {
            if (isset($periods[$sid])) {
                $routePeriod[$id] = $periods[$sid];
            }
        }
        return [
            'holidays' => Dates::holidayMap($plan),
            'route_period' => $routePeriod,
            'customers' => $customers,
            'types' => $types,
            'type_order' => array_flip(array_keys($types)),
            'route_ov' => $routeOv,
        ];
    }

    /** R2: 'work' or 'rest'. */
    public static function dayClass(array $plan, string $d): string
    {
        return Dates::dayClass($d, Dates::holidayMap($plan));
    }

    // ---- R7 route generation -------------------------------------------------------------------

    /**
     * R7 without overrides: 'scheduled', 'holiday_skipped', or null when the route does not generate $d.
     * @param array<string,mixed> $holidays date => name
     */
    public static function routeBaseStatus(array $route, string $d, array $holidays): ?string
    {
        if (Usage::isOneOff($route)) {
            return $route['date'] === $d ? 'scheduled' : null;
        }
        if ($d < (string) ($route['start'] ?? '9999-12-31') || (($route['end'] ?? null) !== null && $d > $route['end'])) {
            return null;
        }
        $dow = Dates::weekday($d);
        $holiday = isset($holidays[$d]);
        if ($route['type'] === 'regular') {
            if (!in_array($dow, $route['days'] ?? [], true)) {
                return null;
            }
            return $holiday ? 'holiday_skipped' : 'scheduled'; // regular routes pause on a Mon-Sat PH
        }
        if ($route['type'] === 'special') {
            // generated at most once, even when a Sunday is also a PH
            return ((!empty($route['sun']) && $dow === 7) || (!empty($route['ph']) && $holiday)) ? 'scheduled' : null;
        }
        return null;
    }

    /**
     * The first date >= $from that the route generates (any status, overrides ignored), or null
     * (searched up to $maxDays ahead). R12 uses it with $from = today.
     */
    public static function firstGenerated(array $route, string $from, array $holidays, int $maxDays = 400): ?string
    {
        if (Usage::isOneOff($route)) {
            return $route['date'] >= $from ? $route['date'] : null;
        }
        $d = max($from, (string) $route['start']);
        for ($i = 0; $i < $maxDays; $i++, $d = Dates::addDays($d, 1)) {
            if (($route['end'] ?? null) !== null && $d > $route['end']) {
                return null;
            }
            if (self::routeBaseStatus($route, $d, $holidays) !== null) {
                return $d;
            }
        }
        return null;
    }

    /** The override of a recurring route on $d, or null. */
    public static function routeOverride(array $ix, array $route, string $d): ?array
    {
        return Usage::isOneOff($route) ? null : ($ix['route_ov'][$route['id'] . '@' . $d] ?? null);
    }

    /**
     * R8: a stop list minus customers that are unknown, inactive or no longer registered with the
     * route's waste type.
     * @return list<array{customer_id:int,note:string}>
     */
    public static function filterStops(array $ix, array $stops, string $wasteType): array
    {
        $out = [];
        foreach ($stops as $s) {
            $cid = (int) ($s['customer_id'] ?? 0);
            $cu = $ix['customers'][$cid] ?? null;
            if ($cu !== null && !empty($cu['active']) && in_array($wasteType, $cu['waste_types'] ?? [], true)) {
                $out[] = ['customer_id' => $cid, 'note' => (string) ($s['note'] ?? '')];
            }
        }
        return $out;
    }

    /** The route's standing stops that apply on $d: no days, or weekday($d) among them (template order). */
    public static function templateStops(array $route, string $d): array
    {
        $dow = Dates::weekday($d);
        return array_values(array_filter($route['stops'] ?? [], static fn ($s) => !isset($s['days']) || in_array($dow, $s['days'], true)));
    }

    /**
     * R8 effective stops of (route, d): override(d).stops ?? the template's stops due on weekday(d), minus
     * inactive/non-routable customers.
     * @return list<array{customer_id:int,note:string}>
     */
    public static function effectiveStops(array $plan, array $route, string $d, ?array $ix = null): array
    {
        $ix ??= self::index($plan);
        $ov = self::routeOverride($ix, $route, $d);
        $stops = ($ov !== null && is_array($ov['stops'] ?? null)) ? $ov['stops'] : self::templateStops($route, $d);
        return self::filterStops($ix, $stops, Usage::routeType($route));
    }

    /** The plan side of one route occurrence on $d, or null when the route does not generate $d. */
    public static function routeOccurrence(array $plan, array $route, string $d, ?array $ix = null): ?array
    {
        $ix ??= self::index($plan);
        $status = self::routeBaseStatus($route, $d, $ix['holidays']);
        if ($status === null) {
            return null;
        }
        $oneOff = Usage::isOneOff($route);
        $ov = self::routeOverride($ix, $route, $d);
        $occNote = '';
        if ($ov !== null) {
            if (!empty($ov['cancelled']) && $status === 'scheduled') {
                $status = 'cancelled';
            }
            $occNote = (string) ($ov['note'] ?? '');
        }
        $routeNote = (string) ($route['note'] ?? '');
        $stops = [];
        foreach (self::effectiveStops($plan, $route, $d, $ix) as $n => $s) {
            $stops[] = ['seq' => $n + 1, 'customer_id' => $s['customer_id'], 'note' => $s['note']];
        }
        return [
            'key' => 'r' . $route['id'] . '@' . $d,
            'kind' => 'route',
            'route_id' => (int) $route['id'],
            'code' => $route['code'],
            'color' => (int) ($route['color'] ?? 1),
            'type' => $route['type'],
            'waste_type' => Usage::routeType($route),
            'name' => (string) ($route['name'] ?? ''),
            'date' => $d,
            'recurring' => !$oneOff,
            'days' => (!$oneOff && $route['type'] === 'regular') ? array_values($route['days'] ?? []) : null,
            'sun' => (!$oneOff && $route['type'] === 'special') ? !empty($route['sun']) : null,
            'ph' => (!$oneOff && $route['type'] === 'special') ? !empty($route['ph']) : null,
            'start' => $oneOff ? null : ($route['start'] ?? null),
            'end' => $oneOff ? null : ($route['end'] ?? null),
            // start / end are this record's; route_start / route_end the route's real period when it was split (R14)
            'route_start' => $oneOff ? null : ($ix['route_period'][(int) $route['id']][0] ?? $route['start'] ?? null),
            'route_end' => $oneOff ? null : (isset($ix['route_period'][(int) $route['id']]) ? $ix['route_period'][(int) $route['id']][1] : ($route['end'] ?? null)),
            'status' => $status,
            'edited' => $ov !== null,
            // §5.2: the occurrence note wins when set; route_note / occurrence_note are given separately too.
            'note' => $occNote !== '' ? $occNote : $routeNote,
            'route_note' => $routeNote,
            'occurrence_note' => $occNote,
            'rev' => (int) ($route['rev'] ?? 1),
            'copied_from' => $oneOff ? ($route['copied_from'] ?? null) : null,
            'stops' => $stops,
        ];
    }

    /**
     * §5.2 Schedule::routesOn(plan, d): every route occurrence on $d (scheduled, cancelled and
     * holiday_skipped), sorted per §5.8. Valid for live dates (d > plan.frozen_through).
     */
    public static function routesOn(array $plan, string $d, ?array $ix = null): array
    {
        $ix ??= self::index($plan);
        $out = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $o = self::routeOccurrence($plan, $r, $d, $ix);
            if ($o !== null) {
                $out[] = $o;
            }
        }
        return self::sortRoutes($out);
    }

    // ---- jobs (for the Runs part, R21) ---------------------------------------------------------

    /**
     * The plan side of job $job ('r5') on $date, or null when it has no occurrence that day:
     * for $date < $today the frozen snapshot entry from $dayDoc (days/<date>.json), otherwise the live
     * occurrence. Check ['status'] === 'scheduled' for runnable jobs (R7).
     */
    public static function jobOccurrence(array $plan, ?array $dayDoc, string $date, string $job, string $today): ?array
    {
        if (!preg_match('/^r([1-9][0-9]*)$/', $job, $m)) {
            return null;
        }
        $id = (int) $m[1];
        if ($date < $today) {
            foreach (($dayDoc['plan'] ?? null) ?: [] as $e) {
                if (($e['kind'] ?? '') === 'route' && (int) ($e['route_id'] ?? 0) === $id) {
                    return $e + ['date' => $date, 'waste_type' => Usage::DEFAULT_ROUTE_TYPE];
                }
            }
            return null;
        }
        foreach ($plan['routes'] ?? [] as $item) {
            if ((int) $item['id'] === $id) {
                return self::routeOccurrence($plan, $item, $date);
            }
        }
        return null;
    }

    /**
     * R21 stop list of a job as customer ids: a route's effective stops (frozen for past dates, live
     * otherwise). [] when the job has no occurrence.
     * @return list<int>
     */
    public static function jobStopIds(array $plan, ?array $dayDoc, string $date, string $job, string $today): array
    {
        $o = self::jobOccurrence($plan, $dayDoc, $date, $job, $today);
        return array_map(static fn ($s) => (int) $s['customer_id'], $o['stops'] ?? []);
    }

    // ---- §5.8 order --------------------------------------------------------------------------

    /** Routes of one day: adhoc first, then by code (natural order); holiday_skipped (Paused) last. */
    public static function sortRoutes(array $occs): array
    {
        $group = static fn (array $o): int => ($o['status'] === 'holiday_skipped') ? 2 : ($o['type'] === 'adhoc' ? 0 : 1);
        usort($occs, static function (array $a, array $b) use ($group): int {
            return ($group($a) <=> $group($b))
                ?: strnatcasecmp((string) $a['code'], (string) $b['code'])
                ?: ($a['route_id'] <=> $b['route_id']);
        });
        return $occs;
    }

    // ---- R13 freeze ----------------------------------------------------------------------------

    /**
     * §4.7 frozen plan of date $d: every route occurrence (cancelled and holiday_skipped too)
     * with the identity fields the drawer shows, so the past renders even after a rename or delete.
     */
    public static function snapshot(array $plan, string $d): array
    {
        $ix = self::index($plan);
        $out = [];
        foreach (self::routesOn($plan, $d, $ix) as $o) {
            unset($o['rev'], $o['date']);
            $o['stops'] = array_map(static fn ($s) => ['customer_id' => $s['customer_id'], 'note' => $s['note']], $o['stops']);
            $out[] = $o;
        }
        return $out;
    }

    /**
     * R13, at the start of every locked request (before_request, order 10):
     * 1. frozen_through >= today -> 503 CLOCK_BEHIND_FREEZE (nothing is written);
     * 2. frozen_through < today - 1 -> write days/<d>.json.plan for every d up to today - 1, then
     *    frozen_through = today - 1. A day file that already has a plan keeps it (written once).
     */
    public static function freezeHook(Ctx $c): void
    {
        $plan = $c->tx->get('plan');
        $ft = $plan['frozen_through'] ?? null;
        if (!is_string($ft) || !Dates::valid($ft)) {
            return;
        }
        if ($ft >= $c->today) {
            throw new ApiError('CLOCK_BEHIND_FREEZE', 503, null, ['frozen_through' => $ft, 'today' => $c->today]);
        }
        $yesterday = Dates::addDays($c->today, -1);
        if ($ft >= $yesterday) {
            return;
        }
        for ($d = Dates::addDays($ft, 1); $d <= $yesterday; $d = Dates::addDays($d, 1)) {
            $doc = 'day:' . $d;
            $day = $c->tx->get($doc);
            if (($day['plan'] ?? null) === null) {
                $day['plan'] = self::snapshot($plan, $d);
                $c->tx->put($doc, $day);
            }
        }
        $plan['frozen_through'] = $yesterday;
        $c->tx->put('plan', $plan);
    }
}
