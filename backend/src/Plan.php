<?php
// Plan writes and reads for routes and tasks (§6, §10.5, §10.6):
//   routes: identity R5 (code, colour), types R6, stop lists R10, past lock R11, save scope R12,
//           change schedule R14, copy to date R15, overrides R9, revisions R20;
//   tasks:  R17 validation, R18 generation (Schedule), R19 overrides and "move one date";
//   plan_write hooks (src/hooks/30_plan_rules.php): R9/R19 override cleanup and the R26 run invariant.
// Every plan write goes through $c->savePlan(), so the hooks also cover the master-data writes
// (holidays, customer detach/archive) of the core part.
final class Plan
{
    /** §9.1 route palette (index -> colour). Routes store the index (R5). */
    public const PALETTE = [1 => '#4E79A7', 2 => '#F28E2B', 3 => '#E15759', 4 => '#76B7B2', 5 => '#59A14F',
        6 => '#EDC948', 7 => '#B07AA1', 8 => '#FF9DA7', 9 => '#9C755F', 10 => '#17BECF'];
    public const CODE_RE = '/^[A-Z0-9][A-Z0-9-]{0,7}$/';
    public const ROUTE_TYPES = ['regular', 'special', 'adhoc'];
    private const OPEN_END = '9999-12-31';

    // =============================================================================================
    // Shared helpers
    // =============================================================================================

    public static function routeIndex(array $plan, int $id): ?int
    {
        foreach ($plan['routes'] ?? [] as $i => $r) {
            if ((int) $r['id'] === $id) {
                return $i;
            }
        }
        return null;
    }

    public static function taskIndex(array $plan, int $id): ?int
    {
        foreach ($plan['tasks'] ?? [] as $i => $t) {
            if ((int) $t['id'] === $id) {
                return $i;
            }
        }
        return null;
    }

    private static function mustRoute(array $plan, int $id): int
    {
        return self::routeIndex($plan, $id) ?? throw new ApiError('NOT_FOUND', 404, 'id', null, 'Route not found');
    }

    private static function mustTask(array $plan, int $id): int
    {
        return self::taskIndex($plan, $id) ?? throw new ApiError('NOT_FOUND', 404, 'id', null, 'Task not found');
    }

    /** A body value that is present and not empty (null, false, [] and '' count as absent). */
    private static function given(array $b, string $k): bool
    {
        return array_key_exists($k, $b) && $b[$k] !== null && $b[$k] !== false && $b[$k] !== [] && $b[$k] !== '';
    }

    /** An optional boolean flag such as release_run / skip_source (absent or null = false). */
    private static function flag(array $b, string $k): bool
    {
        return array_key_exists($k, $b) && $b[$k] !== null && V::bool($b[$k], $k);
    }

    private static function cut(string $s, int $max): string
    {
        return preg_match('/^.{0,' . $max . '}/us', $s, $m) ? $m[0] : $s;
    }

    /** R20: the rev the write is based on must equal the item's rev (409 STALE_REVISION {current}). */
    private static function checkRev(array $item, mixed $rev): void
    {
        if (is_string($rev) && preg_match('/^\d{1,9}$/', $rev)) {
            $rev = (int) $rev;
        }
        if (!is_int($rev)) {
            throw new ApiError('VALIDATION', 422, 'rev', null, "Send the 'rev' this change is based on");
        }
        $current = (int) ($item['rev'] ?? 1);
        if ($rev !== $current) {
            throw new ApiError('STALE_REVISION', 409, 'rev', ['current' => $current]);
        }
    }

    /** R11: a date a plan write sets must be >= today. */
    private static function notPast(string $date, string $today, string $field): void
    {
        if ($date < $today) {
            throw new ApiError('PAST_DATE_LOCKED', 422, $field, ['date' => $date, 'today' => $today]);
        }
    }

    /** R11: an end must be >= today - 1. */
    private static function endNotPast(?string $end, string $today, string $field = 'end'): void
    {
        if ($end !== null && $end < Dates::addDays($today, -1)) {
            throw new ApiError('PAST_DATE_LOCKED', 422, $field, ['date' => $end, 'today' => $today]);
        }
    }

    private static function optDate(mixed $v, string $field): ?string
    {
        return $v === null ? null : V::date($v, $field);
    }

    // =============================================================================================
    // Routes: output, identity (R5), legality (R6), stops (R10)
    // =============================================================================================

    /** Route as returned by the API: every key present, null where it does not apply. */
    public static function routeOut(array $r): array
    {
        $oneOff = Usage::isOneOff($r);
        return [
            'id' => (int) $r['id'],
            'code' => $r['code'],
            'color' => (int) $r['color'],
            'type' => $r['type'],
            'name' => (string) ($r['name'] ?? ''),
            'note' => (string) ($r['note'] ?? ''),
            'rev' => (int) ($r['rev'] ?? 1),
            'recurring' => !$oneOff,
            'date' => $oneOff ? $r['date'] : null,
            'start' => $oneOff ? null : $r['start'],
            'end' => $oneOff ? null : ($r['end'] ?? null),
            'days' => (!$oneOff && $r['type'] === 'regular') ? array_values($r['days'] ?? []) : null,
            'sun' => (!$oneOff && $r['type'] === 'special') ? !empty($r['sun']) : null,
            'ph' => (!$oneOff && $r['type'] === 'special') ? !empty($r['ph']) : null,
            'copied_from' => $oneOff ? ($r['copied_from'] ?? null) : null,
            'stops' => array_map(static fn ($s) => ['customer_id' => (int) $s['customer_id'], 'note' => (string) ($s['note'] ?? '')], $r['stops'] ?? []),
        ];
    }

    /** The stored shape (§4.4), keys in a fixed order. */
    private static function canonRoute(array $r): array
    {
        $out = ['id' => (int) $r['id'], 'code' => $r['code'], 'color' => (int) $r['color'], 'type' => $r['type'],
            'name' => (string) $r['name'], 'note' => (string) ($r['note'] ?? ''), 'rev' => (int) $r['rev']];
        if (Usage::isOneOff($r)) {
            $out += ['date' => $r['date'], 'copied_from' => $r['copied_from'] ?? null];
        } elseif ($r['type'] === 'regular') {
            $out += ['start' => $r['start'], 'end' => $r['end'] ?? null, 'days' => array_values($r['days'])];
        } else {
            $out += ['start' => $r['start'], 'end' => $r['end'] ?? null, 'sun' => !empty($r['sun']), 'ph' => !empty($r['ph'])];
        }
        if (!Usage::isOneOff($r) && isset($r['series'])) {
            $out['series'] = (int) $r['series']; // the records of one split route share it (Usage::seriesMap)
        }
        $out['stops'] = array_values($r['stops'] ?? []);
        return $out;
    }

    /**
     * A route as a handler returns it: routeOut() plus the route as the office sees it when a split (R12/R14)
     * made it several records: "series" (the id the records share; null for a one-off) and "route_start" /
     * "route_end" (the first record's start, the last record's end; null for a one-off). "start" / "end" stay
     * the record's own, which writes are based on.
     */
    private static function routeView(array $plan, array $r, ?array $map = null, ?array $periods = null): array
    {
        $out = self::routeOut($r);
        if (!$out['recurring']) {
            return $out + ['series' => null, 'route_start' => null, 'route_end' => null];
        }
        $map ??= Usage::seriesMap($plan);
        $sid = $map[(int) $r['id']] ?? (int) $r['id'];
        $periods ??= Usage::seriesPeriods($plan, $map);
        [$start, $end] = $periods[$sid] ?? [$r['start'], $r['end'] ?? null];
        return $out + ['series' => $sid, 'route_start' => $start, 'route_end' => $end];
    }

    private static function routeRef(array $r): array
    {
        $o = self::routeOut($r);
        return ['id' => $o['id'], 'code' => $o['code'], 'name' => $o['name'], 'type' => $o['type'],
            'date' => $o['date'], 'start' => $o['start'], 'end' => $o['end']];
    }

    /** R5 code: trimmed, upper-cased, ^[A-Z0-9][A-Z0-9-]{0,7}$. */
    public static function normalizeCode(mixed $v, string $field = 'code'): string
    {
        if (!is_string($v) || trim($v) === '') {
            V::fail($field, 'The route code is required');
        }
        $code = strtoupper(trim($v));
        if (!preg_match(self::CODE_RE, $code)) {
            V::fail($field, 'The route code must be 1-8 letters, digits or "-", starting with a letter or digit');
        }
        return $code;
    }

    /** R5 period: [date, date] for a one-off, [start, end or open] for a recurring route. */
    public static function period(array $r): array
    {
        if (Usage::isOneOff($r)) {
            return [$r['date'], $r['date']];
        }
        return [(string) $r['start'], $r['end'] ?? self::OPEN_END];
    }

    /** The route using $code in a period that overlaps [$start, $end], or null. */
    public static function codeOwner(array $plan, string $code, string $start, string $end, int $exceptId = 0): ?array
    {
        if ($end < $start) {
            return null;
        }
        foreach ($plan['routes'] ?? [] as $r) {
            if ((int) $r['id'] === $exceptId || strcasecmp((string) $r['code'], $code) !== 0) {
                continue;
            }
            [$s, $e] = self::period($r);
            if ($e >= $s && $s <= $end && $start <= $e) {
                return $r;
            }
        }
        return null;
    }

    /**
     * R5: 422 CODE_IN_USE {route} when another route has this code in an overlapping period. When that "other
     * route" is a later part of the same split route (an ended part's end moved into it), the error says so.
     */
    private static function checkCodeFree(array $plan, array $r): void
    {
        [$s, $e] = self::period($r);
        $owner = self::codeOwner($plan, $r['code'], $s, $e, (int) $r['id']);
        if ($owner !== null) {
            if (!Usage::isOneOff($r) && !Usage::isOneOff($owner)) {
                $map = Usage::seriesMap($plan); // $r may be a route that is not stored yet (POST)
                if (($map[(int) $r['id']] ?? null) !== null && $map[(int) $owner['id']] === $map[(int) $r['id']]) {
                    V::fail('end', 'This part of the route has ended and a later part of it runs in this period: change the route from a current date');
                }
            }
            throw new ApiError('CODE_IN_USE', 422, 'code', ['route' => self::routeRef($owner)],
                "Code {$r['code']} is used by another route in this period");
        }
    }

    /** R5 colour: the index used by the fewest routes whose period reaches today or later; ties -> lowest. */
    public static function autoColor(array $plan, string $today): int
    {
        $count = array_fill(1, count(self::PALETTE), 0);
        foreach ($plan['routes'] ?? [] as $r) {
            $k = (int) ($r['color'] ?? 0);
            if (isset($count[$k]) && Usage::routeLive($r, $today)) {
                $count[$k]++;
            }
        }
        $best = 1;
        foreach ($count as $k => $n) {
            if ($n < $count[$best]) {
                $best = $k;
            }
        }
        return $best;
    }

    /** R5 suggestion for a new one-off: <prefix><n>, n the smallest integer >= 1 free on $date. */
    public static function suggestOneOff(array $plan, string $prefix, string $date): string
    {
        for ($n = 1; ; $n++) {
            if (self::codeOwner($plan, $prefix . $n, $date, $date) === null) {
                return $prefix . $n;
            }
        }
    }

    /**
     * R5 suggestion for Copy to date: <first 5 chars of the source code>-<DD of the target>.
     * When that is taken on the target date, a letter is added (N1-25B …) to stay within 8 characters.
     */
    public static function suggestCopy(array $plan, string $srcCode, string $date): string
    {
        $dd = substr($date, 8, 2);
        $base = substr($srcCode, 0, 5);
        $code = $base . '-' . $dd;
        if (self::codeOwner($plan, $code, $date, $date) === null) {
            return $code;
        }
        foreach (range('B', 'Z') as $letter) {
            $code = substr($base, 0, 4) . '-' . $dd . $letter;
            if (self::codeOwner($plan, $code, $date, $date) === null) {
                return $code;
            }
        }
        return self::suggestOneOff($plan, substr($base, 0, 3) . $dd, $date);
    }

    /** R6 for a one-off on $date: adhoc on a work day, special on a rest day, regular (copies only) on a work day. */
    private static function checkOneOffClass(array $plan, string $type, string $date, bool $allowRegular): void
    {
        $class = Schedule::dayClass($plan, $date);
        $ok = match ($type) {
            'adhoc' => $class === 'work',
            'special' => $class === 'rest',
            default => $allowRegular && $class === 'work',
        };
        if (!$ok) {
            $why = match ($type) {
                'adhoc' => 'An adhoc route cannot be on a Sunday or a public holiday',
                'special' => 'A one-off special route must be on a Sunday or a public holiday',
                default => 'A regular one-off route is created only by Copy to date, on a work day',
            };
            throw new ApiError('DAY_CLASS_VIOLATION', 422, 'date', ['type' => $type, 'date' => $date, 'class' => $class], $why);
        }
    }

    /** R6 regular days: a non-empty subset of 1..6, de-duplicated and sorted (422 WEEKDAY_NOT_ALLOWED). */
    private static function regularDays(mixed $v): array
    {
        if (!is_array($v) || !array_is_list($v) || $v === []) {
            throw new ApiError('WEEKDAY_NOT_ALLOWED', 422, 'days', null, 'Pick at least one weekday from Monday to Saturday');
        }
        foreach ($v as $d) {
            if (!is_int($d) || $d < 1 || $d > 6) {
                throw new ApiError('WEEKDAY_NOT_ALLOWED', 422, 'days', ['day' => $d], 'Regular routes run Monday to Saturday only');
            }
        }
        $v = array_values(array_unique($v));
        sort($v);
        return $v;
    }

    /**
     * Applies the recurring schedule fields of $b (start, end, days | sun, ph) to route $r and checks
     * R6 and R11 (on create, or on a field whose value changes).
     */
    private static function applyRecurring(array $r, array $b, string $today, bool $creating): array
    {
        if ($creating || array_key_exists('start', $b)) {
            $start = V::date($b['start'] ?? null, 'start');
            if ($creating || $start !== ($r['start'] ?? null)) {
                self::notPast($start, $today, 'start');
            }
            $r['start'] = $start;
        }
        if ($creating || array_key_exists('end', $b)) {
            $end = self::optDate($b['end'] ?? null, 'end');
            if ($creating || $end !== ($r['end'] ?? null)) {
                self::endNotPast($end, $today);
            }
            $r['end'] = $end;
        }
        if (($r['end'] ?? null) !== null && $r['end'] < Dates::addDays($r['start'], -1)) {
            V::fail('end', 'The end cannot be before the start');
        }
        if ($r['type'] === 'regular') {
            if ($creating || array_key_exists('days', $b)) {
                $r['days'] = self::regularDays($b['days'] ?? null);
            }
            foreach (['sun', 'ph'] as $f) {
                if (self::given($b, $f)) {
                    throw new ApiError('WEEKDAY_NOT_ALLOWED', 422, $f, null, 'Regular routes run Monday to Saturday only; use a special route');
                }
            }
        } else {
            if (self::given($b, 'days')) {
                throw new ApiError('DAY_CLASS_VIOLATION', 422, 'days', null, 'Special routes run every Sunday and/or every PH, not on weekdays');
            }
            foreach (['sun', 'ph'] as $f) {
                if ($creating || array_key_exists($f, $b)) {
                    $r[$f] = ($b[$f] ?? null) === null ? false : V::bool($b[$f], $f);
                }
            }
            if (empty($r['sun']) && empty($r['ph'])) {
                throw new ApiError('DAY_CLASS_VIOLATION', 422, 'sun', null, 'A special route needs every Sunday and/or every PH');
            }
        }
        return $r;
    }

    /**
     * R10: every stop's customer exists, is active (CUSTOMER_INACTIVE) and routable (CUSTOMER_NOT_ROUTABLE),
     * at most once (DUPLICATE_STOP). Returns [{customer_id, note}].
     */
    public static function validateStops(array $plan, mixed $stops, string $field = 'stops'): array
    {
        V::list($stops, $field);
        $types = Usage::typesByCode($plan);
        $customers = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $customers[(int) $cu['id']] = $cu;
        }
        $seen = [];
        $out = [];
        foreach ($stops as $n => $s) {
            $f = "$field.$n";
            if (!is_array($s) || array_is_list($s)) {
                V::fail($f, 'Each stop is {"customer_id", "note"}');
            }
            V::only($s, ['customer_id', 'note']);
            $cid = V::id($s['customer_id'] ?? null, "$f.customer_id");
            $cu = $customers[$cid] ?? null;
            if ($cu === null) {
                throw new ApiError('VALIDATION', 422, "$f.customer_id", ['customer_id' => $cid], 'Unknown customer');
            }
            if (empty($cu['active'])) {
                throw new ApiError('CUSTOMER_INACTIVE', 422, "$f.customer_id", ['customer_id' => $cid, 'name' => $cu['name']]);
            }
            if (!Usage::customerRoutable($cu, $types)) {
                throw new ApiError('CUSTOMER_NOT_ROUTABLE', 422, "$f.customer_id", ['customer_id' => $cid, 'name' => $cu['name']]);
            }
            if (isset($seen[$cid])) {
                throw new ApiError('DUPLICATE_STOP', 422, "$f.customer_id", ['customer_id' => $cid, 'name' => $cu['name']]);
            }
            $seen[$cid] = true;
            $note = ($s['note'] ?? null) === null ? '' : V::str($s['note'], "$f.note", 0, 200);
            $out[] = ['customer_id' => $cid, 'note' => $note];
        }
        return $out;
    }

    /** Inserts or edits the override of (route, date) with $fn(override): override. Kept sorted by date. */
    private static function upsertRouteOverride(array $plan, int $routeId, string $date, callable $fn): array
    {
        foreach ($plan['route_overrides'] ?? [] as $k => $o) {
            if ((int) $o['route_id'] === $routeId && $o['date'] === $date) {
                $plan['route_overrides'][$k] = $fn($o);
                return $plan;
            }
        }
        $plan['route_overrides'][] = $fn(['route_id' => $routeId, 'date' => $date, 'cancelled' => false, 'stops' => null, 'note' => '']);
        usort($plan['route_overrides'], static fn ($a, $b) => [$a['date'], $a['route_id']] <=> [$b['date'], $b['route_id']]);
        return $plan;
    }

    private static function upsertTaskOverride(array $plan, int $taskId, string $date, callable $fn): array
    {
        foreach ($plan['task_overrides'] ?? [] as $k => $o) {
            if ((int) $o['task_id'] === $taskId && $o['date'] === $date) {
                $plan['task_overrides'][$k] = $fn($o);
                return $plan;
            }
        }
        $plan['task_overrides'][] = $fn(['task_id' => $taskId, 'date' => $date, 'cancelled' => false, 'note' => '']);
        usort($plan['task_overrides'], static fn ($a, $b) => [$a['date'], $a['task_id']] <=> [$b['date'], $b['task_id']]);
        return $plan;
    }

    /** Next date >= $from with a scheduled (runnable) occurrence of the route, or null. */
    public static function nextRouteDate(array $route, string $from, array $ix): ?string
    {
        if (Usage::isOneOff($route)) {
            return $route['date'] >= $from ? $route['date'] : null;
        }
        $d = max($from, (string) $route['start']);
        for ($i = 0; $i < 400; $i++, $d = Dates::addDays($d, 1)) {
            if (($route['end'] ?? null) !== null && $d > $route['end']) {
                return null;
            }
            if (Schedule::routeBaseStatus($route, $d, $ix['holidays']) === 'scheduled'
                && empty(Schedule::routeOverride($ix, $route, $d)['cancelled'])) {
                return $d;
            }
        }
        return null;
    }

    // ---- split routes (R12 / R14) ---------------------------------------------------------------
    // A "following" save and a schedule change end the route at D - 1 and continue it as a new record with
    // the same code and type from D, linked by `series` (Usage::seriesMap). To the office they are ONE route,
    // so one rule holds for every operation on a record that runs today or later: it applies to the whole
    // live chain from its date on. Edit route "from today" (code, colour, name, note, weekdays, template) reaches
    // every live record; its start is the route's first start and its end the route's end (End route from D
    // ends the record that runs on D - 1 and deletes the later ones, which have not started); Change schedule
    // and "this date and following" from D split the record that runs on D and carry the change into the later
    // records, which keep what only they have (a planned schedule change, customers added or removed from
    // their start). An ended record is history: an edit of it stays on it.

    /**
     * Indexes in $plan['routes'] of route $i and every record of its split route, sorted by start.
     * A one-off route is its own chain. @return list<int>
     */
    private static function chain(array $plan, int $i): array
    {
        $r = $plan['routes'][$i];
        if (Usage::isOneOff($r)) {
            return [$i];
        }
        $map = Usage::seriesMap($plan);
        $sid = $map[(int) $r['id']];
        $out = [];
        foreach ($plan['routes'] as $k => $o) {
            if (!Usage::isOneOff($o) && $map[(int) $o['id']] === $sid) {
                $out[] = $k;
            }
        }
        usort($out, static fn (int $a, int $b) => [(string) $plan['routes'][$a]['start'], (int) $plan['routes'][$a]['id']]
            <=> [(string) $plan['routes'][$b]['start'], (int) $plan['routes'][$b]['id']]);
        return $out;
    }

    /**
     * The records of route $i's chain that run today or later, sorted by start; only $i when it has ended
     * (an edit or delete of an ended record stays on it). @return list<int>
     */
    private static function liveChain(array $plan, int $i, string $today): array
    {
        if (!Usage::routeLive($plan['routes'][$i], $today)) {
            return [$i];
        }
        return array_values(array_filter(self::chain($plan, $i), static fn (int $k) => Usage::routeLive($plan['routes'][$k], $today)));
    }

    /** @return list<int> the ids of the records at indexes $idx */
    private static function idsOf(array $plan, array $idx): array
    {
        return array_map(static fn (int $k) => (int) $plan['routes'][$k]['id'], $idx);
    }

    /** Writes `series` (Usage::seriesMap: its own id) on records stored without it, so that a split links its new record. */
    private static function linkChain(array $plan, array $idx): array
    {
        $map = Usage::seriesMap($plan);
        foreach ($idx as $k) {
            if (!isset($plan['routes'][$k]['series'])) {
                $plan['routes'][$k]['series'] = $map[(int) $plan['routes'][$k]['id']];
                $plan['routes'][$k] = self::canonRoute($plan['routes'][$k]);
            }
        }
        return $plan;
    }

    /**
     * Puts $fields on route $id. Its rev goes up once per request ($bumped holds the ids already bumped),
     * and only when something changed.
     */
    private static function setRoute(array $plan, int $id, array $fields, array &$bumped): array
    {
        $k = self::routeIndex($plan, $id);
        $r = array_replace($plan['routes'][$k], $fields);
        if ($r !== $plan['routes'][$k]) {
            if (!isset($bumped[$id])) {
                $r['rev'] = (int) ($r['rev'] ?? 1) + 1;
                $bumped[$id] = true;
            }
            $plan['routes'][$k] = self::canonRoute($r);
        }
        return $plan;
    }

    /** Removes routes $ids and their overrides. */
    private static function dropRoutes(array $plan, array $ids): array
    {
        $ids = array_flip($ids);
        $plan['routes'] = array_values(array_filter($plan['routes'], static fn ($r) => !isset($ids[(int) $r['id']])));
        $plan['route_overrides'] = array_values(array_filter($plan['route_overrides'] ?? [], static fn ($o) => !isset($ids[(int) $o['route_id']])));
        return $plan;
    }

    /**
     * The change a record went through ($old -> $new) carried into a later or other live record $t of the same
     * route: code, colour, name and note; weekdays (or Sunday / PH) added or removed; with $stops, the customers
     * added, removed, moved or re-noted. What only $t has (a planned schedule change, customers added or
     * removed from its start) is kept.
     */
    private static function carry(array $t, array $old, array $new, bool $stops): array
    {
        foreach (['code', 'color', 'name', 'note'] as $f) {
            if ($new[$f] !== $old[$f]) {
                $t[$f] = $new[$f];
            }
        }
        if ($new['type'] === 'regular' && $new['days'] !== $old['days']) {
            $days = array_diff(array_unique(array_merge($t['days'], array_diff($new['days'], $old['days']))), array_diff($old['days'], $new['days']));
            sort($days);
            $t['days'] = $days === [] ? $new['days'] : array_values($days);
        } elseif ($new['type'] === 'special') {
            foreach (['sun', 'ph'] as $f) {
                if (!empty($new[$f]) !== !empty($old[$f])) {
                    $t[$f] = !empty($new[$f]);
                }
            }
            if (empty($t['sun']) && empty($t['ph'])) {
                [$t['sun'], $t['ph']] = [!empty($new['sun']), !empty($new['ph'])];
            }
        }
        if ($stops && $new['stops'] !== $old['stops']) {
            $t['stops'] = self::mergeStops($old['stops'], $new['stops'], $t['stops'] ?? []);
        }
        return $t;
    }

    /**
     * Stop list $seg with the change from $old to $new applied (carry()). A list equal to $old becomes $new.
     * Otherwise: removed customers leave; changed stop notes follow; when customers in both lists were moved,
     * they take the new order in the places they hold in $seg; an added customer goes before the nearest
     * customer after it in $new that $seg has (else at the end), unless $seg already has it.
     */
    private static function mergeStops(array $old, array $new, array $seg): array
    {
        if ($seg === $old) {
            return $new;
        }
        $ids = static fn (array $l): array => array_map(static fn ($s) => (int) $s['customer_id'], $l);
        $oldIds = $ids($old);
        $newIds = $ids($new);
        $oldNote = array_column($old, 'note', 'customer_id');
        $newNote = array_column($new, 'note', 'customer_id');
        $out = [];
        foreach ($seg as $s) {
            $cid = (int) $s['customer_id'];
            if (in_array($cid, $oldIds, true) && !in_array($cid, $newIds, true)) {
                continue;
            }
            if (isset($oldNote[$cid], $newNote[$cid]) && $oldNote[$cid] !== $newNote[$cid]) {
                $s['note'] = $newNote[$cid];
            }
            $out[] = $s;
        }
        $after = array_values(array_intersect($newIds, $oldIds));
        if (array_values(array_intersect($oldIds, $newIds)) !== $after) {
            $slots = [];
            $byId = [];
            foreach ($out as $p => $s) {
                if (in_array((int) $s['customer_id'], $after, true)) {
                    $slots[] = $p;
                    $byId[(int) $s['customer_id']] = $s;
                }
            }
            $order = array_values(array_filter($after, static fn (int $cid) => isset($byId[$cid])));
            foreach ($slots as $n => $p) {
                $out[$p] = $byId[$order[$n]];
            }
        }
        foreach ($new as $pos => $s) {
            $cid = (int) $s['customer_id'];
            $have = $ids($out);
            if (in_array($cid, $oldIds, true) || in_array($cid, $have, true)) {
                continue;
            }
            $at = count($out);
            for ($q = $pos + 1; $q < count($new); $q++) {
                $p = array_search((int) $new[$q]['customer_id'], $have, true);
                if ($p !== false) {
                    $at = $p;
                    break;
                }
            }
            array_splice($out, $at, 0, [$s]);
        }
        return $out;
    }

    /**
     * The route's end (End route from D sets D - 1; an end typed in Edit route), on its live records $ids
     * (sorted by start): the last record that starts on or before the end gets it, and the later ones, which
     * have not started yet, are deleted with their overrides. null removes the end (from the last record).
     * @return array{0:array,1:int} [plan, id of the record that now holds the route's end]
     */
    private static function setChainEnd(array $plan, array $ids, ?string $end, string $today, array &$bumped): array
    {
        $recs = array_map(static fn (int $id) => $plan['routes'][self::routeIndex($plan, $id)], $ids);
        if ($end !== (end($recs)['end'] ?? null)) {
            self::endNotPast($end, $today);
        }
        if ($end !== null && $end < Dates::addDays((string) $recs[0]['start'], -1)) {
            V::fail('end', 'The end cannot be before the start');
        }
        $keep = [];
        $drop = [];
        foreach ($recs as $n => $r) {
            if ($n === 0 || $end === null || $r['start'] <= $end) {
                $keep[] = (int) $r['id'];
            } else {
                $drop[] = (int) $r['id'];
            }
        }
        $holder = end($keep);
        $plan = self::setRoute($plan, $holder, ['end' => $end], $bumped);
        return [self::dropRoutes($plan, $drop), $holder];
    }

    /** The route's start, sent from a later record: it goes to the first live record ($ids sorted by start). */
    private static function setChainStart(array $plan, array $ids, string $start, string $today, array &$bumped): array
    {
        $first = $plan['routes'][self::routeIndex($plan, $ids[0])];
        self::notPast($start, $today, 'start');
        if (($first['end'] ?? null) !== null && $start > Dates::addDays($first['end'], 1)) {
            V::fail('start', 'The route changes schedule on ' . Dates::label(Dates::addDays($first['end'], 1)) . ': the start must be before that date');
        }
        return self::setRoute($plan, $ids[0], ['start' => $start], $bumped);
    }

    /** R5 after a write: no other route uses the code of a route the write created or whose code or period it changed. */
    private static function checkCodesChanged(array $plan, array $before): void
    {
        $was = [];
        foreach ($before['routes'] ?? [] as $r) {
            $was[(int) $r['id']] = $r;
        }
        foreach ($plan['routes'] ?? [] as $r) {
            $o = $was[(int) $r['id']] ?? null;
            if ($o === null || $o['code'] !== $r['code'] || self::period($o) !== self::period($r)) {
                self::checkCodeFree($plan, $r);
            }
        }
    }

    public static function nextTaskDate(array $task, string $from, array $ix): ?string
    {
        if (Usage::isOneOff($task)) {
            return $task['date'] >= $from ? $task['date'] : null;
        }
        $d = max($from, (string) $task['start']);
        for ($i = 0; $i < 400; $i++, $d = Dates::addDays($d, 1)) {
            if (($task['end'] ?? null) !== null && $d > $task['end']) {
                return null;
            }
            if (Schedule::taskGenerates($task, $d) && empty(Schedule::taskOverride($ix, $task, $d)['cancelled'])) {
                return $d;
            }
        }
        return null;
    }

    // =============================================================================================
    // Route endpoints (§10.5)
    // =============================================================================================

    /**
     * GET /api/routes?ended=0|1 (1 = include ended routes). One row per route record; the records of a split
     * route share "series" and carry the route's real period (route_start / route_end) and next date
     * (route_next_date), so the office can show them as one route.
     */
    public static function listRoutes(Ctx $c): array
    {
        $plan = $c->plan();
        $all = $c->queryBool('ended');
        $ix = Schedule::index($plan);
        $cal = Calendar::forCtx($c);
        $map = Usage::seriesMap($plan);
        $periods = Usage::seriesPeriods($plan, $map);
        $next = [];
        $seriesNext = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $id = (int) $r['id'];
            $next[$id] = self::nextRouteDate($r, $c->today, $ix);
            if ($next[$id] !== null && ($seriesNext[$map[$id]] ?? '9999-12-31') > $next[$id]) {
                $seriesNext[$map[$id]] = $next[$id];
            }
        }
        $out = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $live = Usage::routeLive($r, $c->today);
            if (!$all && !$live) {
                continue;
            }
            $o = self::routeView($plan, $r, $map, $periods);
            unset($o['stops']);
            $o['stop_count'] = count(Schedule::filterStops($ix, $r['stops'] ?? []));
            $o['next_date'] = $next[(int) $r['id']];
            $o['route_next_date'] = $seriesNext[$map[(int) $r['id']]] ?? null;
            $o['today_status'] = $cal->todayStatus('r' . $r['id']);
            $o['ended'] = !$live;
            $out[] = $o;
        }
        usort($out, static fn ($a, $b) => strnatcasecmp($a['code'], $b['code'])
            ?: strcmp((string) ($a['start'] ?? $a['date']), (string) ($b['start'] ?? $b['date'])) ?: ($a['id'] <=> $b['id']));
        return $out;
    }

    /**
     * GET /api/routes/{id} -> Route + overrides dated >= today + next_date + parts. For a record of a split route the
     * overrides are those of every live record (each names its route_id), so the scope dialog (§6.2) names
     * every later date that has its own list; route_next_date is the route's next date. "parts" are the records
     * an edit of this one reaches (liveChain: the live records sorted by start, or only this one when it has
     * ended), each {id, start, end, days, sun, ph, stops}, so the office can show before a save what a later
     * part keeps (carry(), §6.5); null for a one-off.
     */
    public static function getRoute(Ctx $c): array
    {
        $plan = $c->plan();
        $i = self::mustRoute($plan, $c->intParam('id'));
        $r = $plan['routes'][$i];
        $live = self::liveChain($plan, $i, $c->today);
        $parts = Usage::isOneOff($r) ? null : array_map(static function (int $k) use ($plan): array {
            $o = self::routeOut($plan['routes'][$k]);
            return ['id' => $o['id'], 'start' => $o['start'], 'end' => $o['end'], 'days' => $o['days'], 'sun' => $o['sun'], 'ph' => $o['ph'], 'stops' => $o['stops']];
        }, $live);
        $ids = array_flip(self::idsOf($plan, $live));
        $ix = Schedule::index($plan);
        $ovs = [];
        foreach ($plan['route_overrides'] ?? [] as $o) {
            if (isset($ids[(int) $o['route_id']]) && $o['date'] >= $c->today) {
                $ovs[] = ['route_id' => (int) $o['route_id'], 'date' => $o['date'], 'cancelled' => !empty($o['cancelled']),
                    'stops' => $o['stops'] ?? null, 'note' => (string) ($o['note'] ?? '')];
            }
        }
        usort($ovs, static fn ($a, $b) => [$a['date'], $a['route_id']] <=> [$b['date'], $b['route_id']]);
        $next = null;
        foreach (array_keys($ids) as $id) {
            $d = self::nextRouteDate($plan['routes'][self::routeIndex($plan, $id)], $c->today, $ix);
            $next = ($d !== null && ($next === null || $d < $next)) ? $d : $next;
        }
        return self::routeView($plan, $r) + ['overrides' => $ovs, 'next_date' => self::nextRouteDate($r, $c->today, $ix), 'route_next_date' => $next,
            'parts' => $parts];
    }

    /** POST /api/routes -> 201 Route (colour auto-assigned when null; warning EMPTY_ROUTE). */
    public static function createRoute(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['type', 'code', 'color', 'name', 'note', 'start', 'end', 'days', 'sun', 'ph', 'date', 'stops']);
        $plan = $c->plan();
        $type = V::enum($b['type'] ?? null, 'type', self::ROUTE_TYPES);
        $r = ['id' => 0, 'code' => self::normalizeCode($b['code'] ?? null), 'color' => 1, 'type' => $type,
            'name' => V::str($b['name'] ?? null, 'name', 1, 100), 'note' => V::optStr($b, 'note', 500), 'rev' => 1];
        if (array_key_exists('date', $b) && $b['date'] !== null) {
            foreach (['start', 'end', 'days', 'sun', 'ph'] as $f) {
                if (self::given($b, $f)) {
                    throw new ApiError('DAY_CLASS_VIOLATION', 422, $f, null, 'A one-off route has only a date');
                }
            }
            $r['date'] = V::date($b['date'], 'date');
            self::notPast($r['date'], $c->today, 'date');
            self::checkOneOffClass($plan, $type, $r['date'], false);
            $r['copied_from'] = null;
        } else {
            if ($type === 'adhoc') {
                throw new ApiError('DAY_CLASS_VIOLATION', 422, 'date', null, 'An adhoc route is for one date only: give its date');
            }
            $r = self::applyRecurring($r, $b, $c->today, true);
        }
        $r['stops'] = self::validateStops($plan, $b['stops'] ?? [], 'stops');
        $r['color'] = self::given($b, 'color') ? V::int($b['color'], 'color', 1, count(self::PALETTE)) : self::autoColor($plan, $c->today);
        $r['id'] = (int) ($plan['seq']['route'] ?? 0) + 1;
        $plan['seq']['route'] = $r['id'];
        if (!Usage::isOneOff($r)) {
            $r['series'] = $r['id']; // a new route, never a record of another one that had this code (SPLIT-1)
        }
        $r = self::canonRoute($r);
        self::checkCodeFree($plan, $r);
        $plan['routes'][] = $r;
        $c->savePlan($plan);
        if ($r['stops'] === []) {
            $c->warn('EMPTY_ROUTE');
        }
        return $c->created(self::routeView($plan, $r));
    }

    /**
     * PATCH /api/routes/{id} {rev, code?, color?, name?, note?, days?, sun?, ph?, start?, end?, date?, stops?, release_run?}
     * An edit "from today". On a live record of a split route it applies to the whole route: code, colour,
     * name, note, weekdays and the template reach every live record (carry()); "end" is the route's end
     * (setChainEnd) and "start" its first start (setChainStart). Returns the record, or the record that now
     * holds the route's end when the opened one was a later record that the end removed.
     */
    public static function patchRoute(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'type', 'code', 'color', 'name', 'note', 'days', 'sun', 'ph', 'start', 'end', 'date', 'stops', 'release_run']);
        $plan = $c->plan();
        $i = self::mustRoute($plan, $c->intParam('id'));
        $old = $plan['routes'][$i];
        self::checkRev($old, $b['rev'] ?? null);
        if (Usage::isOneOff($old)) {
            self::notPast($old['date'], $c->today, 'date'); // R11/R13: a one-off dated before today is frozen
        }
        if (array_key_exists('type', $b) && $b['type'] !== $old['type']) {
            throw new ApiError('TYPE_IMMUTABLE', 422, 'type', ['type' => $old['type']]);
        }
        $before = $plan;
        $r = $old;
        if (array_key_exists('code', $b)) {
            $r['code'] = self::normalizeCode($b['code']);
        }
        if (self::given($b, 'color')) {
            $r['color'] = V::int($b['color'], 'color', 1, count(self::PALETTE));
        }
        if (array_key_exists('name', $b)) {
            $r['name'] = V::str($b['name'], 'name', 1, 100);
        }
        if (array_key_exists('note', $b)) {
            $r['note'] = V::optStr($b, 'note', 500);
        }
        $live = [$i];
        $start = null;
        $end = false;
        if (Usage::isOneOff($old)) {
            foreach (['start', 'end', 'days', 'sun', 'ph'] as $f) {
                if (self::given($b, $f)) {
                    V::fail($f, 'A one-off route has only a date');
                }
            }
            if (array_key_exists('date', $b) && $b['date'] !== $old['date']) {
                $r['date'] = V::date($b['date'], 'date');
                self::notPast($r['date'], $c->today, 'date');
                self::checkOneOffClass($plan, $r['type'], $r['date'], true); // R6 re-checked on a date change
            }
        } else {
            if (self::given($b, 'date')) {
                V::fail('date', 'A recurring route has a start and an end, not a date');
            }
            $plan = self::linkChain($plan, self::chain($plan, $i));
            $old = $plan['routes'][$i];
            $r = array_replace($old, array_intersect_key($r, array_flip(['code', 'color', 'name', 'note'])));
            $live = self::liveChain($plan, $i, $c->today);
            $sched = $b;
            if (array_key_exists('start', $b) && $b['start'] !== $old['start']
                && $b['start'] === $plan['routes'][self::chain($plan, $i)[0]]['start']) {
                unset($sched['start']); // the route's real start, resent by a form that shows the whole route
            }
            if (count($live) > 1) {
                if (array_key_exists('start', $sched) && $sched['start'] !== $old['start']) {
                    $start = V::date($sched['start'], 'start');
                }
                if (array_key_exists('end', $sched)) {
                    $end = self::optDate($sched['end'], 'end');
                }
                unset($sched['start'], $sched['end']);
            }
            $r = self::applyRecurring($r, $sched, $c->today, false);
        }
        if (array_key_exists('stops', $b)) {
            $r['stops'] = self::validateStops($plan, $b['stops'], 'stops');
        }
        $r['rev'] = (int) ($old['rev'] ?? 1) + 1;
        $r = self::canonRoute($r);
        $plan['routes'][$i] = $r;
        $bumped = [(int) $r['id'] => true];
        $ids = self::idsOf($plan, $live);
        foreach ($live as $k) {
            if ($k !== $i) {
                $plan = self::setRoute($plan, (int) $plan['routes'][$k]['id'], self::carry($plan['routes'][$k], $old, $r, array_key_exists('stops', $b)), $bumped);
            }
        }
        $holder = (int) $r['id'];
        if ($start !== null) {
            $plan = self::setChainStart($plan, $ids, $start, $c->today, $bumped);
        }
        if ($end !== false) {
            [$plan, $last] = self::setChainEnd($plan, $ids, $end, $c->today, $bumped);
            if (self::routeIndex($plan, $holder) === null) {
                $holder = $last;
            }
        }
        self::checkCodesChanged($plan, $before);
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        if (array_key_exists('stops', $b) && $r['stops'] === []) {
            $c->warn('EMPTY_ROUTE');
        }
        return self::routeView($plan, $plan['routes'][self::routeIndex($plan, $holder)]);
    }

    /**
     * DELETE /api/routes/{id}?rev=4[&release_run=1] -> 204 (the route and its overrides; past days stay frozen).
     * A split route goes as a whole: the other records of it that run today or later are deleted too.
     */
    public static function deleteRoute(Ctx $c): mixed
    {
        $plan = $c->plan();
        $id = $c->intParam('id');
        $i = self::mustRoute($plan, $id);
        self::checkRev($plan['routes'][$i], $c->query('rev'));
        if (Usage::isOneOff($plan['routes'][$i])) {
            self::notPast($plan['routes'][$i]['date'], $c->today, 'date'); // R11/R13: a one-off dated before today is frozen
        }
        $plan = self::dropRoutes($plan, self::idsOf($plan, self::liveChain($plan, $i, $c->today)));
        $c->savePlan($plan, ['release_run' => $c->queryBool('release_run')]);
        return $c->noContent();
    }

    /** POST /api/routes/{id}/change-schedule {rev, from, days?|sun?,ph?, end?, stops?, release_run?} -> {ended, created} */
    public static function changeSchedule(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'from', 'days', 'sun', 'ph', 'end', 'stops', 'release_run']);
        $plan = $c->plan();
        $i = self::mustRoute($plan, $c->intParam('id'));
        self::checkRev($plan['routes'][$i], $b['rev'] ?? null);
        $from = V::date($b['from'] ?? null, 'from');
        [$plan, $ended, $created] = self::split($plan, $i, $from, $b, $c->today);
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        if (array_key_exists('stops', $b) && $created['stops'] === []) {
            $c->warn('EMPTY_ROUTE');
        }
        return ['ended' => self::routeView($plan, $ended), 'created' => self::routeView($plan, $created)];
    }

    /**
     * R14 change schedule from D (D > today), one transaction. D may fall in any live record of a split route
     * (§6.5): the record that runs on D is the one split. end = D - 1 on it; a copy (new id, same code, colour
     * and series, $b's stops or the same ones) from D with $b's days/sun/ph or the old ones, up to the record's
     * end; overrides dated >= D move to the copy; copied_from of one-offs {old id, date >= D} re-pointed. When D
     * is the first day of a later record, that record takes the new schedule instead (nothing to split). The
     * later records get the same change (carry()). $b's end is the route's end (setChainEnd); an end equal to
     * the route's current end is no change. The form sends `end` only when the clerk changed it, so an end that
     * happens to equal a split boundary is applied, not dropped.
     * @return array{0:array,1:array,2:array} [plan, ended record, created (or changed) record]
     */
    private static function split(array $plan, int $i, string $from, array $b, string $today): array
    {
        $opened = $plan['routes'][$i];
        if (Usage::isOneOff($opened)) {
            V::fail('from', 'A one-off route has no schedule: change its date instead');
        }
        self::notPast($from, $today, 'from');
        if ($from === $today) {
            V::fail('from', 'A change from today is a route edit, not a new schedule');
        }
        $before = $plan;
        $plan = self::linkChain($plan, self::chain($plan, $i));
        $live = self::liveChain($plan, $i, $today);
        $lastEnd = $plan['routes'][end($live)]['end'] ?? null;
        if ($from <= $plan['routes'][$live[0]]['start']) {
            V::fail('from', 'The new schedule must start after the route starts: edit the route instead');
        }
        $n = 0;
        foreach ($live as $p => $k) {
            if ($plan['routes'][$k]['start'] <= $from) {
                $n = $p;
            }
        }
        $k = $live[$n];
        $seg = $plan['routes'][$k];
        if (($seg['end'] ?? null) !== null && $from > $seg['end']) {
            V::fail('from', 'The route ends before this date');
        }
        $sched = array_intersect_key($b, array_flip(['days', 'sun', 'ph']));
        $bumped = [];
        if ($from === $seg['start']) {
            $new = self::applyRecurring($seg, $sched, $today, false);
            if (array_key_exists('stops', $b) && $b['stops'] !== null) {
                $new['stops'] = self::validateStops($plan, $b['stops'], 'stops');
            }
            $new['rev'] = (int) ($seg['rev'] ?? 1) + 1;
            $plan['routes'][$k] = self::canonRoute($new);
            $bumped[(int) $seg['id']] = true;
            $endedId = (int) $plan['routes'][$live[$n - 1]]['id'];
            $createdId = (int) $seg['id'];
        } else {
            $createdId = (int) ($plan['seq']['route'] ?? 0) + 1;
            $plan['seq']['route'] = $createdId;
            $new = $seg;
            $new['id'] = $createdId;
            $new['rev'] = 1;
            $new['start'] = $from;
            $new = self::applyRecurring($new, $sched, $today, false);
            if (array_key_exists('stops', $b) && $b['stops'] !== null) {
                $new['stops'] = self::validateStops($plan, $b['stops'], 'stops');
            }
            $ended = $seg;
            $ended['end'] = Dates::addDays($from, -1);
            $ended['rev'] = (int) ($seg['rev'] ?? 1) + 1;
            $plan['routes'][$k] = self::canonRoute($ended);
            $plan['routes'][] = self::canonRoute($new);
            $bumped += [(int) $seg['id'] => true, $createdId => true];
            foreach ($plan['route_overrides'] ?? [] as $o => $ov) {
                if ((int) $ov['route_id'] === (int) $seg['id'] && $ov['date'] >= $from) {
                    $plan['route_overrides'][$o]['route_id'] = $createdId;
                }
            }
            foreach ($plan['routes'] as $q => $r) {
                $cf = $r['copied_from'] ?? null;
                if (Usage::isOneOff($r) && is_array($cf) && (int) $cf['route_id'] === (int) $seg['id'] && $cf['date'] >= $from) {
                    $plan['routes'][$q]['copied_from']['route_id'] = $createdId;
                    $plan['routes'][$q]['rev'] = (int) ($r['rev'] ?? 1) + 1;
                }
            }
            $endedId = (int) $seg['id'];
        }
        $created = $plan['routes'][self::routeIndex($plan, $createdId)];
        foreach (array_slice($live, $n + 1) as $l) {
            $plan = self::setRoute($plan, (int) $plan['routes'][$l]['id'], self::carry($plan['routes'][$l], $seg, $created, true), $bumped);
        }
        if (array_key_exists('end', $b)) {
            $end = self::optDate($b['end'], 'end');
            if ($end !== $lastEnd) {
                if ($end !== null && $end < $from) {
                    V::fail('end', 'The end cannot be before the start');
                }
                $ids = self::idsOf($plan, $live);
                $ids[] = $createdId;
                $ids = array_values(array_unique($ids));
                usort($ids, static fn (int $a, int $c) => $plan['routes'][self::routeIndex($plan, $a)]['start'] <=> $plan['routes'][self::routeIndex($plan, $c)]['start']);
                [$plan] = self::setChainEnd($plan, $ids, $end, $today, $bumped);
            }
        }
        self::checkCodesChanged($plan, $before);
        return [$plan, $plan['routes'][self::routeIndex($plan, $endedId)], $plan['routes'][self::routeIndex($plan, $createdId)]];
    }

    /**
     * PUT /api/routes/{id}/dates/{date} {rev, scope, stops?, note?, cancelled?, release_run?}
     * -> {route, occurrence} (+ "ended" when "following" split the route, R12/R14).
     */
    public static function putRouteDate(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'scope', 'stops', 'note', 'cancelled', 'release_run']);
        $date = $c->dateParam('date');
        $plan = $c->plan();
        $i = self::mustRoute($plan, $c->intParam('id'));
        $route = $plan['routes'][$i];
        self::checkRev($route, $b['rev'] ?? null);
        $scope = V::enum($b['scope'] ?? 'this', 'scope', ['this', 'following']);
        self::notPast($date, $c->today, 'date');
        $hasStops = array_key_exists('stops', $b);
        $stops = ($hasStops && $b['stops'] !== null) ? self::validateStops($plan, $b['stops'], 'stops') : null;
        $note = array_key_exists('note', $b) ? V::optStr($b, 'note', 500) : null;
        $cancelled = (array_key_exists('cancelled', $b) && $b['cancelled'] !== null) ? V::bool($b['cancelled'], 'cancelled') : null;
        $targetId = (int) $route['id'];
        $ended = null;

        if (Usage::isOneOff($route)) {
            // One-off routes save directly, with no scope question (R12).
            if ($route['date'] !== $date) {
                throw new ApiError('NOT_AN_OCCURRENCE', 422, 'date', ['date' => $date]);
            }
            if ($cancelled === true) {
                V::fail('cancelled', 'A one-off route is deleted, not skipped');
            }
            if ($hasStops) {
                if ($stops === null) {
                    V::fail('stops', 'A one-off route needs its stop list');
                }
                $route['stops'] = $stops;
            }
            if ($note !== null) {
                $route['note'] = $note;
            }
            $route['rev'] = (int) ($route['rev'] ?? 1) + 1;
            $plan['routes'][$i] = $route;
        } else {
            $holidays = Dates::holidayMap($plan);
            if (Schedule::routeBaseStatus($route, $date, $holidays) === null) {
                throw new ApiError('NOT_AN_OCCURRENCE', 422, 'date', ['date' => $date]);
            }
            if ($scope === 'this') {
                // Only this date: override(D).stops / note / cancelled.
                $plan = self::upsertRouteOverride($plan, $targetId, $date, static function (array $o) use ($hasStops, $stops, $note, $cancelled): array {
                    if ($hasStops) {
                        $o['stops'] = $stops;
                    }
                    if ($note !== null) {
                        $o['note'] = $note;
                    }
                    if ($cancelled !== null) {
                        $o['cancelled'] = $cancelled;
                    }
                    return $o;
                });
                $plan['routes'][$i]['rev'] = (int) ($route['rev'] ?? 1) + 1;
            } else {
                // This date and following (R12).
                if ($cancelled === true) {
                    V::fail('cancelled', 'Skipping applies to "only this date"');
                }
                if ($stops !== null && Schedule::firstGenerated($route, $c->today, $holidays) !== $date) {
                    [$plan, $ended, $created] = self::split($plan, $i, $date, ['stops' => $stops], $c->today);
                    $targetId = (int) $created['id'];
                } else {
                    $plan['routes'][$i]['rev'] = (int) ($route['rev'] ?? 1) + 1;
                    if ($stops !== null) {
                        // D is the next date the route runs: replace the template, and carry the change into the
                        // later records of a split route (§6.5)
                        $plan['routes'][$i]['stops'] = $stops;
                        $bumped = [$targetId => true];
                        $live = self::liveChain($plan, $i, $c->today);
                        foreach (array_slice($live, (int) array_search($i, $live, true) + 1) as $l) {
                            $plan = self::setRoute($plan, (int) $plan['routes'][$l]['id'], self::carry($plan['routes'][$l], $route, $plan['routes'][$i], true), $bumped);
                        }
                    }
                }
                // override(D).stops is cleared; the occurrence note belongs to D (R9 removes an empty override).
                $plan = self::upsertRouteOverride($plan, $targetId, $date, static function (array $o) use ($note): array {
                    $o['stops'] = null;
                    if ($note !== null) {
                        $o['note'] = $note;
                    }
                    return $o;
                });
            }
        }
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        $plan = $c->plan();
        $occ = Calendar::forCtx($c)->routeOccurrence($targetId, $date);
        if ($hasStops && $occ !== null && $occ['stops'] === []) {
            $c->warn('EMPTY_ROUTE');
        }
        $out = ['route' => self::routeView($plan, $plan['routes'][self::mustRoute($plan, $targetId)]), 'occurrence' => $occ];
        if ($ended !== null) {
            $out['ended'] = self::routeView($plan, $ended);
        }
        return $out;
    }

    /** DELETE /api/routes/{id}/dates/{date}?rev=4[&release_run=1] -> {route, occurrence} (reset to route default). */
    public static function resetRouteDate(Ctx $c): array
    {
        $date = $c->dateParam('date');
        $plan = $c->plan();
        $id = $c->intParam('id');
        $i = self::mustRoute($plan, $id);
        $route = $plan['routes'][$i];
        self::checkRev($route, $c->query('rev'));
        self::notPast($date, $c->today, 'date');
        if (Usage::isOneOff($route)) {
            V::fail('date', 'A one-off route has no per-date changes');
        }
        $n = count($plan['route_overrides'] ?? []);
        $plan['route_overrides'] = array_values(array_filter($plan['route_overrides'] ?? [],
            static fn ($o) => !((int) $o['route_id'] === $id && $o['date'] === $date)));
        if (count($plan['route_overrides']) !== $n) {
            $plan['routes'][$i]['rev'] = (int) ($route['rev'] ?? 1) + 1;
        }
        $c->savePlan($plan, ['release_run' => $c->queryBool('release_run')]);
        $plan = $c->plan();
        return ['route' => self::routeView($plan, $plan['routes'][self::mustRoute($plan, $id)]),
            'occurrence' => Calendar::forCtx($c)->routeOccurrence($id, $date)];
    }

    /**
     * POST /api/routes/{id}/dates/{src}/copy {rev, to, code?, name?, note?, skip_source?, release_run?}
     * -> 201 {created: Route} (R15).
     */
    public static function copyRouteDate(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'to', 'code', 'name', 'note', 'skip_source', 'release_run']);
        $src = $c->dateParam('date');
        $id = $c->intParam('id');
        $plan = $c->plan();
        $i = self::routeIndex($plan, $id);
        $route = $i === null ? null : $plan['routes'][$i];
        if ($route !== null) {
            self::checkRev($route, $b['rev'] ?? null);
        }
        $source = self::sourceOccurrence($c, $plan, 'route', $id, $route, $src);
        $to = V::date($b['to'] ?? null, 'to');
        self::notPast($to, $c->today, 'to');
        // R15 type: special on a rest day; on a work day adhoc stays adhoc, everything else becomes a regular one-off.
        $type = Schedule::dayClass($plan, $to) === 'rest' ? 'special' : ($source['type'] === 'adhoc' ? 'adhoc' : 'regular');
        $new = [
            'id' => (int) ($plan['seq']['route'] ?? 0) + 1,
            'code' => self::given($b, 'code') ? self::normalizeCode($b['code']) : self::suggestCopy($plan, (string) $source['code'], $to),
            'color' => (int) ($source['color'] ?? 1),
            'type' => $type,
            'name' => self::given($b, 'name') ? V::str($b['name'], 'name', 1, 100)
                : self::cut($source['name'] . ' (from ' . Dates::label($src) . ')', 100),
            'note' => V::optStr($b, 'note', 500),
            'rev' => 1,
            'date' => $to,
            'copied_from' => ['route_id' => $id, 'date' => $src],
            'stops' => Schedule::filterStops(Schedule::index($plan), $source['stops'] ?? []),
        ];
        $plan['seq']['route'] = $new['id'];
        $new = self::canonRoute($new);
        self::checkCodeFree($plan, $new);
        $plan['routes'][] = $new;
        if (self::flag($b, 'skip_source')) {
            if ($src < $c->today) {
                V::fail('skip_source', 'Only a date from today on can be skipped');
            }
            if ($route === null || Usage::isOneOff($route) || ($source['status'] ?? '') !== 'scheduled') {
                V::fail('skip_source', 'Only a scheduled date of a recurring route can be skipped');
            }
            $plan = self::upsertRouteOverride($plan, $id, $src, static fn (array $o): array => array_replace($o, ['cancelled' => true]));
            $plan['routes'][$i]['rev'] = (int) ($route['rev'] ?? 1) + 1;
        }
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        if ($new['stops'] === []) {
            $c->warn('EMPTY_ROUTE');
        }
        return $c->created(['created' => self::routeView($plan, $new)]);
    }

    /**
     * The occurrence a copy starts from: the frozen snapshot for a past date (R15 "a past date is read from
     * its frozen plan", also after the route was deleted), otherwise the live occurrence.
     */
    private static function sourceOccurrence(Ctx $c, array $plan, string $kind, int $id, ?array $item, string $src): array
    {
        $idKey = $kind === 'route' ? 'route_id' : 'task_id';
        if ($src < $c->today) {
            foreach (($c->tx->get('day:' . $src)['plan'] ?? null) ?: [] as $e) {
                if (($e['kind'] ?? '') === $kind && (int) ($e[$idKey] ?? 0) === $id) {
                    return $e;
                }
            }
        } elseif ($item !== null) {
            $occ = $kind === 'route' ? Schedule::routeOccurrence($plan, $item, $src) : Schedule::taskOccurrence($plan, $item, $src);
            if ($occ !== null) {
                return $occ;
            }
        }
        if ($item === null) {
            throw new ApiError('NOT_FOUND', 404, 'id', null, ucfirst($kind) . ' not found');
        }
        throw new ApiError('NOT_AN_OCCURRENCE', 422, 'date', ['date' => $src]);
    }

    /** GET /api/routes/suggest-code?type=adhoc|special|copy&date=D[&route_id=5] -> {code, class, holiday, type} */
    public static function suggestCode(Ctx $c): array
    {
        $kind = V::enum($c->query('type'), 'type', ['adhoc', 'special', 'copy']);
        $date = V::date($c->query('date'), 'date');
        $plan = $c->plan();
        $holidays = Dates::holidayMap($plan);
        $class = Dates::dayClass($date, $holidays);
        if ($kind === 'copy') {
            $rid = $c->query('route_id');
            if (!is_string($rid) || !preg_match('/^[1-9][0-9]{0,9}$/', $rid)) {
                V::fail('route_id', 'route_id is required for type=copy');
            }
            $src = $plan['routes'][self::mustRoute($plan, (int) $rid)];
            $type = $class === 'rest' ? 'special' : ($src['type'] === 'adhoc' ? 'adhoc' : 'regular');
            $code = self::suggestCopy($plan, (string) $src['code'], $date);
        } else {
            // A new one-off: adhoc on a work day; on a rest day it becomes a special one-off (never silently).
            $type = $class === 'work' ? 'adhoc' : 'special';
            $code = self::suggestOneOff($plan, $type === 'adhoc' ? 'A' : 'S', $date);
        }
        return ['code' => $code, 'class' => $class, 'holiday' => $holidays[$date] ?? null, 'type' => $type];
    }

    // =============================================================================================
    // Tasks (R17-R19, §10.6)
    // =============================================================================================

    public static function taskOut(array $t): array
    {
        $oneOff = Usage::isOneOff($t);
        return [
            'id' => (int) $t['id'],
            'waste_type' => $t['waste_type'],
            'customer_id' => (int) $t['customer_id'],
            'note' => (string) ($t['note'] ?? ''),
            'rev' => (int) ($t['rev'] ?? 1),
            'recurring' => !$oneOff,
            'date' => $oneOff ? $t['date'] : null,
            'start' => $oneOff ? null : $t['start'],
            'end' => $oneOff ? null : ($t['end'] ?? null),
            'days' => $oneOff ? null : array_values($t['days'] ?? []),
            'copied_from' => $oneOff ? ($t['copied_from'] ?? null) : null,
        ];
    }

    private static function canonTask(array $t): array
    {
        $out = ['id' => (int) $t['id'], 'waste_type' => $t['waste_type'], 'customer_id' => (int) $t['customer_id'],
            'note' => (string) ($t['note'] ?? ''), 'rev' => (int) $t['rev']];
        if (Usage::isOneOff($t)) {
            return $out + ['date' => $t['date'], 'copied_from' => $t['copied_from'] ?? null];
        }
        return $out + ['start' => $t['start'], 'end' => $t['end'] ?? null, 'days' => array_values($t['days'])];
    }

    /**
     * R17: the waste type exists, is active (UNKNOWN_WASTE_TYPE {inactive}) and non-routable (TYPE_ROUTABLE);
     * the customer is active (CUSTOMER_INACTIVE) and registered for it (CUSTOMER_LACKS_TYPE).
     * @return array{0:array,1:array} [waste type, customer]
     */
    private static function checkTaskTarget(array $plan, mixed $code, mixed $cid): array
    {
        $types = Usage::typesByCode($plan);
        if (!is_string($code) || !isset($types[$code])) {
            throw new ApiError('UNKNOWN_WASTE_TYPE', 422, 'waste_type', ['code' => $code]);
        }
        $type = $types[$code];
        if (!empty($type['routable'])) {
            throw new ApiError('TYPE_ROUTABLE', 422, 'waste_type', ['code' => $code],
                "$code is collected on routes: add the customer to a route instead");
        }
        if (empty($type['active'])) {
            throw new ApiError('UNKNOWN_WASTE_TYPE', 422, 'waste_type', ['code' => $code, 'inactive' => true], "Waste type $code is inactive");
        }
        $cid = V::id($cid, 'customer_id');
        $k = Customers::index($plan, $cid);
        if ($k === null) {
            throw new ApiError('VALIDATION', 422, 'customer_id', ['customer_id' => $cid], 'Unknown customer');
        }
        $cu = $plan['customers'][$k];
        if (empty($cu['active'])) {
            throw new ApiError('CUSTOMER_INACTIVE', 422, 'customer_id', ['customer_id' => $cid, 'name' => $cu['name']]);
        }
        if (!in_array($code, $cu['waste_types'] ?? [], true)) {
            throw new ApiError('CUSTOMER_LACKS_TYPE', 422, 'customer_id', ['customer_id' => $cid, 'waste_type' => $code]);
        }
        return [$type, $cu];
    }

    /** Task days: a non-empty subset of 1..7 (Sunday allowed), de-duplicated and sorted. */
    private static function taskDays(mixed $v): array
    {
        if (!is_array($v) || !array_is_list($v) || $v === []) {
            V::fail('days', 'Pick at least one weekday');
        }
        foreach ($v as $d) {
            if (!is_int($d) || $d < 1 || $d > 7) {
                V::fail('days', 'Weekdays are 1 (Monday) to 7 (Sunday)');
            }
        }
        $v = array_values(array_unique($v));
        sort($v);
        return $v;
    }

    private static function applyTaskSchedule(array $t, array $b, string $today, bool $creating): array
    {
        if ($creating || array_key_exists('start', $b)) {
            $start = V::date($b['start'] ?? null, 'start');
            if ($creating || $start !== ($t['start'] ?? null)) {
                self::notPast($start, $today, 'start');
            }
            $t['start'] = $start;
        }
        if ($creating || array_key_exists('end', $b)) {
            $end = self::optDate($b['end'] ?? null, 'end');
            if ($creating || $end !== ($t['end'] ?? null)) {
                self::endNotPast($end, $today);
            }
            $t['end'] = $end;
        }
        if (($t['end'] ?? null) !== null && $t['end'] < Dates::addDays($t['start'], -1)) {
            V::fail('end', 'The end cannot be before the start');
        }
        if ($creating || array_key_exists('days', $b)) {
            $t['days'] = self::taskDays($b['days'] ?? null);
        }
        return $t;
    }

    private static function customerRef(array $plan, int $cid): array
    {
        $k = Customers::index($plan, $cid);
        $cu = $k === null ? null : $plan['customers'][$k];
        return ['id' => $cid, 'code' => $cu['code'] ?? '', 'name' => $cu['name'] ?? ''];
    }

    /** GET /api/tasks?type=OTC&kind=one_off|recurring&ended=0|1 */
    public static function listTasks(Ctx $c): array
    {
        $plan = $c->plan();
        $type = $c->query('type');
        $kind = $c->query('kind');
        if ($kind !== null && $kind !== '') {
            V::enum($kind, 'kind', ['one_off', 'recurring']);
        }
        $all = $c->queryBool('ended');
        $ix = Schedule::index($plan);
        $cal = Calendar::forCtx($c);
        $out = [];
        foreach ($plan['tasks'] ?? [] as $t) {
            $live = Usage::taskLive($t, $c->today);
            if ((!$all && !$live) || ($type !== null && $type !== '' && $t['waste_type'] !== $type)
                || ($kind === 'one_off' && !Usage::isOneOff($t)) || ($kind === 'recurring' && Usage::isOneOff($t))) {
                continue;
            }
            $out[] = self::taskOut($t) + [
                'customer' => self::customerRef($plan, (int) $t['customer_id']),
                'next_date' => self::nextTaskDate($t, $c->today, $ix),
                'today_status' => $cal->todayStatus('t' . $t['id']),
                'ended' => !$live,
            ];
        }
        usort($out, static fn ($a, $b) => [$ix['type_order'][$a['waste_type']] ?? 99, strtolower($a['customer']['name']), $a['id']]
            <=> [$ix['type_order'][$b['waste_type']] ?? 99, strtolower($b['customer']['name']), $b['id']]);
        return $out;
    }

    /** GET /api/tasks/{id} -> Task + customer + overrides dated >= today + next_date. */
    public static function getTask(Ctx $c): array
    {
        $plan = $c->plan();
        $t = $plan['tasks'][self::mustTask($plan, $c->intParam('id'))];
        $ovs = [];
        foreach ($plan['task_overrides'] ?? [] as $o) {
            if ((int) $o['task_id'] === (int) $t['id'] && $o['date'] >= $c->today) {
                $ovs[] = ['task_id' => (int) $o['task_id'], 'date' => $o['date'], 'cancelled' => !empty($o['cancelled']), 'note' => (string) ($o['note'] ?? '')];
            }
        }
        $k = Customers::index($plan, (int) $t['customer_id']);
        return self::taskOut($t) + [
            'customer' => $k === null ? null : Customers::out($plan['customers'][$k]),
            'overrides' => $ovs,
            'next_date' => self::nextTaskDate($t, $c->today, Schedule::index($plan)),
        ];
    }

    /** POST /api/tasks {waste_type, customer_id, date | start, end, days, note} -> 201 Task */
    public static function createTask(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['waste_type', 'customer_id', 'date', 'start', 'end', 'days', 'note']);
        $plan = $c->plan();
        [$type] = self::checkTaskTarget($plan, $b['waste_type'] ?? null, $b['customer_id'] ?? null);
        $t = ['id' => (int) ($plan['seq']['task'] ?? 0) + 1, 'waste_type' => $type['code'], 'customer_id' => (int) $b['customer_id'],
            'note' => V::optStr($b, 'note', 500), 'rev' => 1];
        if (self::given($b, 'start') || self::given($b, 'days') || self::given($b, 'end')) {
            if (self::given($b, 'date')) {
                V::fail('date', 'A task has either a date (one-off) or start and days (recurring)');
            }
            if (empty($type['recurring_tasks'])) {
                throw new ApiError('RECURRING_NOT_ALLOWED', 422, 'days', ['waste_type' => $type['code']]);
            }
            $t = self::applyTaskSchedule($t, $b, $c->today, true);
        } else {
            $t['date'] = V::date($b['date'] ?? null, 'date');
            self::notPast($t['date'], $c->today, 'date');
            $t['copied_from'] = null;
        }
        $plan['seq']['task'] = $t['id'];
        $t = self::canonTask($t);
        $plan['tasks'][] = $t;
        $c->savePlan($plan);
        return $c->created(self::taskOut($t));
    }

    /** PATCH /api/tasks/{id} {rev, note?, date?, days?, start?, end?, release_run?} -> Task | TASK_FIELD_IMMUTABLE */
    public static function patchTask(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'note', 'date', 'days', 'start', 'end', 'release_run', 'waste_type', 'customer_id']);
        $plan = $c->plan();
        $i = self::mustTask($plan, $c->intParam('id'));
        $old = $plan['tasks'][$i];
        self::checkRev($old, $b['rev'] ?? null);
        foreach (['waste_type', 'customer_id'] as $f) {
            if (array_key_exists($f, $b) && $b[$f] !== $old[$f]) {
                throw new ApiError('TASK_FIELD_IMMUTABLE', 422, $f);
            }
        }
        $t = $old;
        if (array_key_exists('note', $b)) {
            $t['note'] = V::optStr($b, 'note', 500);
        }
        if (Usage::isOneOff($old)) {
            foreach (['start', 'end', 'days'] as $f) {
                if (self::given($b, $f)) {
                    throw new ApiError('TASK_FIELD_IMMUTABLE', 422, $f, null, 'A one-off task stays one-off: create a new task');
                }
            }
            if (array_key_exists('date', $b) && $b['date'] !== $old['date']) {
                $t['date'] = V::date($b['date'], 'date');
                self::notPast($t['date'], $c->today, 'date');
            }
        } else {
            if (self::given($b, 'date')) {
                throw new ApiError('TASK_FIELD_IMMUTABLE', 422, 'date', null, 'A recurring task stays recurring: create a new task');
            }
            $t = self::applyTaskSchedule($t, $b, $c->today, false);
        }
        $t['rev'] = (int) ($old['rev'] ?? 1) + 1;
        $t = self::canonTask($t);
        $plan['tasks'][$i] = $t;
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        return self::taskOut($t);
    }

    /** DELETE /api/tasks/{id}?rev=2[&release_run=1] -> 204 (the task and its overrides). */
    public static function deleteTask(Ctx $c): mixed
    {
        $plan = $c->plan();
        $id = $c->intParam('id');
        $i = self::mustTask($plan, $id);
        self::checkRev($plan['tasks'][$i], $c->query('rev'));
        array_splice($plan['tasks'], $i, 1);
        $plan['task_overrides'] = array_values(array_filter($plan['task_overrides'] ?? [], static fn ($o) => (int) $o['task_id'] !== $id));
        $c->savePlan($plan, ['release_run' => $c->queryBool('release_run')]);
        return $c->noContent();
    }

    /** PUT /api/tasks/{id}/dates/{date} {rev, cancelled?, note?, release_run?} -> {task, occurrence} (R19). */
    public static function putTaskDate(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'cancelled', 'note', 'release_run']);
        $date = $c->dateParam('date');
        $plan = $c->plan();
        $id = $c->intParam('id');
        $i = self::mustTask($plan, $id);
        $task = $plan['tasks'][$i];
        self::checkRev($task, $b['rev'] ?? null);
        self::notPast($date, $c->today, 'date');
        if (Usage::isOneOff($task)) {
            V::fail('date', 'A one-off task has no per-date changes: edit or delete the task');
        }
        if (!Schedule::taskGenerates($task, $date)) {
            throw new ApiError('NOT_AN_OCCURRENCE', 422, 'date', ['date' => $date]);
        }
        $note = array_key_exists('note', $b) ? V::optStr($b, 'note', 500) : null;
        $cancelled = (array_key_exists('cancelled', $b) && $b['cancelled'] !== null) ? V::bool($b['cancelled'], 'cancelled') : null;
        $plan = self::upsertTaskOverride($plan, $id, $date, static function (array $o) use ($note, $cancelled): array {
            if ($note !== null) {
                $o['note'] = $note;
            }
            if ($cancelled !== null) {
                $o['cancelled'] = $cancelled;
            }
            return $o;
        });
        $plan['tasks'][$i]['rev'] = (int) ($task['rev'] ?? 1) + 1;
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        $plan = $c->plan();
        return ['task' => self::taskOut($plan['tasks'][self::mustTask($plan, $id)]),
            'occurrence' => Calendar::forCtx($c)->taskOccurrence($id, $date)];
    }

    /** DELETE /api/tasks/{id}/dates/{date}?rev=2[&release_run=1] -> {task, occurrence} (reset). */
    public static function resetTaskDate(Ctx $c): array
    {
        $date = $c->dateParam('date');
        $plan = $c->plan();
        $id = $c->intParam('id');
        $i = self::mustTask($plan, $id);
        $task = $plan['tasks'][$i];
        self::checkRev($task, $c->query('rev'));
        self::notPast($date, $c->today, 'date');
        if (Usage::isOneOff($task)) {
            V::fail('date', 'A one-off task has no per-date changes');
        }
        $n = count($plan['task_overrides'] ?? []);
        $plan['task_overrides'] = array_values(array_filter($plan['task_overrides'] ?? [],
            static fn ($o) => !((int) $o['task_id'] === $id && $o['date'] === $date)));
        if (count($plan['task_overrides']) !== $n) {
            $plan['tasks'][$i]['rev'] = (int) ($task['rev'] ?? 1) + 1;
        }
        $c->savePlan($plan, ['release_run' => $c->queryBool('release_run')]);
        $plan = $c->plan();
        return ['task' => self::taskOut($plan['tasks'][self::mustTask($plan, $id)]),
            'occurrence' => Calendar::forCtx($c)->taskOccurrence($id, $date)];
    }

    /**
     * POST /api/tasks/{id}/dates/{src}/copy {rev, to, skip_source?, note?, release_run?} -> 201 {created: Task}.
     * "Move one date" = skip_source true (R19). A past source is read from its frozen plan.
     */
    public static function copyTaskDate(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['rev', 'to', 'skip_source', 'note', 'release_run']);
        $src = $c->dateParam('date');
        $id = $c->intParam('id');
        $plan = $c->plan();
        $i = self::taskIndex($plan, $id);
        $task = $i === null ? null : $plan['tasks'][$i];
        if ($task !== null) {
            self::checkRev($task, $b['rev'] ?? null);
        }
        $source = self::sourceOccurrence($c, $plan, 'task', $id, $task, $src);
        $to = V::date($b['to'] ?? null, 'to');
        self::notPast($to, $c->today, 'to');
        self::checkTaskTarget($plan, $source['waste_type'] ?? null, (int) ($source['customer_id'] ?? 0));
        $new = self::canonTask([
            'id' => (int) ($plan['seq']['task'] ?? 0) + 1,
            'waste_type' => $source['waste_type'],
            'customer_id' => (int) $source['customer_id'],
            'note' => array_key_exists('note', $b) ? V::optStr($b, 'note', 500) : (string) ($source['task_note'] ?? $source['note'] ?? ''),
            'rev' => 1,
            'date' => $to,
            'copied_from' => ['task_id' => $id, 'date' => $src],
        ]);
        $plan['seq']['task'] = $new['id'];
        $plan['tasks'][] = $new;
        if (self::flag($b, 'skip_source')) {
            if ($src < $c->today) {
                V::fail('skip_source', 'Only a date from today on can be skipped');
            }
            if ($task === null || Usage::isOneOff($task) || ($source['status'] ?? '') !== 'scheduled') {
                V::fail('skip_source', 'Only a scheduled date of a recurring task can be skipped (change the date of a one-off instead)');
            }
            $plan = self::upsertTaskOverride($plan, $id, $src, static fn (array $o): array => array_replace($o, ['cancelled' => true]));
            $plan['tasks'][$i]['rev'] = (int) ($task['rev'] ?? 1) + 1;
        }
        $c->savePlan($plan, ['release_run' => self::flag($b, 'release_run')]);
        return $c->created(['created' => self::taskOut($new)]);
    }

    // =============================================================================================
    // plan_write hooks (registered in src/hooks/30_plan_rules.php)
    // =============================================================================================

    /**
     * R9 / R19 after every plan write: overrides dated before today are purged; overrides of missing or
     * one-off items are dropped; a route override that is not cancelled, has an empty note and inherits
     * (stops null or equal to the template's effective list) is deleted; a task override that is not
     * cancelled and has an empty note is deleted.
     */
    public static function cleanupOverrides(Ctx $c, array $before, array &$after, array $opts): void
    {
        $today = $c->today;
        $ix = Schedule::index($after);
        $routes = [];
        foreach ($after['routes'] ?? [] as $r) {
            $routes[(int) $r['id']] = $r;
        }
        $keep = [];
        foreach ($after['route_overrides'] ?? [] as $o) {
            $r = $routes[(int) $o['route_id']] ?? null;
            if ($r === null || Usage::isOneOff($r) || $o['date'] < $today) {
                continue;
            }
            $inherits = !is_array($o['stops'] ?? null)
                || Schedule::filterStops($ix, $o['stops']) === Schedule::filterStops($ix, $r['stops'] ?? []);
            if (!empty($o['cancelled']) || trim((string) ($o['note'] ?? '')) !== '' || !$inherits) {
                $keep[] = $o;
            }
        }
        $after['route_overrides'] = $keep;
        $tasks = [];
        foreach ($after['tasks'] ?? [] as $t) {
            $tasks[(int) $t['id']] = $t;
        }
        $keep = [];
        foreach ($after['task_overrides'] ?? [] as $o) {
            $t = $tasks[(int) $o['task_id']] ?? null;
            if ($t === null || Usage::isOneOff($t) || $o['date'] < $today) {
                continue;
            }
            if (!empty($o['cancelled']) || trim((string) ($o['note'] ?? '')) !== '') {
                $keep[] = $o;
            }
        }
        $after['task_overrides'] = $keep;
    }

    /**
     * R26 run invariant: after the write, every run in today's day file must still match a today
     * occurrence whose status is scheduled. Otherwise 409 RUN_EXISTS {runs:[{job, code_or_customer,
     * driver, resolved}]}, unless every affected run has resolved = 0 and (release_run is set, or it has
     * no holder): such runs move to dropped_runs (their open hold is closed with end = released).
     * Pending customers dropped from a today occurrence that keeps its run are appended to run.removed.
     * "Affected" = the job was scheduled today before this write; a run that was already an orphan
     * (e.g. after a manual file edit) does not block unrelated writes.
     */
    public static function runInvariant(Ctx $c, array $before, array &$after, array $opts): void
    {
        $doc = 'day:' . $c->today;
        $day = $c->tx->get($doc);
        $runs = Calendar::runsOf($day);
        if ($runs === []) {
            return;
        }
        $now = self::todayJobs($after, $c->today);
        $was = self::todayJobs($before, $c->today);
        $names = [];
        foreach ($c->users()['users'] ?? [] as $u) {
            $names[(int) $u['id']] = $u['name'];
        }
        $changed = false;
        $blocking = [];
        $drop = [];
        foreach ($runs as $job => $run) {
            $occ = $now[$job] ?? null;
            if (($was[$job]['status'] ?? null) !== 'scheduled') {
                continue; // already an orphan before this write (§5.6 shows it); this write does not affect it
            }
            if ($occ !== null && $occ['status'] === 'scheduled') {
                $removed = array_values(($run['removed'] ?? null) ?: []);
                foreach ($was[$job]['stops'] ?? [] as $cid) {
                    if (!in_array($cid, $occ['stops'], true) && !self::isResolved($run, $cid) && !in_array($cid, $removed, true)) {
                        $removed[] = $cid;
                    }
                }
                if ($removed !== array_values(($run['removed'] ?? null) ?: [])) {
                    $runs[$job]['removed'] = $removed;
                    $changed = true;
                }
                continue;
            }
            $resolved = self::resolvedCount($run);
            $holder = $run['driver_id'] ?? null;
            if ($resolved === 0 && ($holder === null || !empty($opts['release_run']))) {
                $drop[] = $job;
                continue;
            }
            $blocking[] = [
                'job' => $job,
                'date' => $c->today,
                'code_or_customer' => $was[$job]['label'] ?? $occ['label'] ?? $job,
                'driver' => $holder === null ? null : ($names[(int) $holder] ?? null),
                'driver_id' => $holder,
                'resolved' => $resolved,
            ];
        }
        if ($blocking !== []) {
            throw new ApiError('RUN_EXISTS', 409, null, ['runs' => $blocking]);
        }
        foreach ($drop as $job) {
            $run = $runs[$job];
            if (($run['driver_id'] ?? null) !== null) {
                foreach (($run['holds'] ?? null) ?: [] as $k => $h) {
                    if (($h['to'] ?? null) === null) {
                        $run['holds'][$k]['to'] = $c->nowIso;
                        $run['holds'][$k]['end'] = 'released';
                    }
                }
                $run['driver_id'] = null;
            }
            $run['dropped_at'] = $c->nowIso;
            $day['dropped_runs'][] = $run;
            unset($runs[$job]);
            $changed = true;
        }
        if ($changed) {
            $day['runs'] = $runs;
            $c->tx->put($doc, $day);
        }
    }

    /** Today's jobs of a plan: job => {status, stops (customer ids), label (route code / "OTC Customer")}. */
    private static function todayJobs(array $plan, string $today): array
    {
        $ix = Schedule::index($plan);
        $out = [];
        foreach (Schedule::routesOn($plan, $today, $ix) as $o) {
            $out['r' . $o['route_id']] = ['status' => $o['status'], 'stops' => array_column($o['stops'], 'customer_id'), 'label' => $o['code']];
        }
        foreach (Schedule::tasksOn($plan, $today, $ix) as $o) {
            $name = $ix['customers'][$o['customer_id']]['name'] ?? ('#' . $o['customer_id']);
            $out['t' . $o['task_id']] = ['status' => $o['status'], 'stops' => [$o['customer_id']], 'label' => $o['waste_type'] . ' ' . $name];
        }
        return $out;
    }

    private static function isResolved(array $run, int $cid): bool
    {
        $o = $run['visits'][$cid]['outcome'] ?? null;
        return $o === 'collected' || $o === 'missed';
    }

    private static function resolvedCount(array $run): int
    {
        $n = 0;
        foreach (($run['visits'] ?? null) ?: [] as $v) {
            $o = is_array($v) ? ($v['outcome'] ?? null) : null;
            $n += ($o === 'collected' || $o === 'missed') ? 1 : 0;
        }
        return $n;
    }
}
