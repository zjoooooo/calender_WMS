<?php
// Read side of the plan (§5.1, §5.6, §5.9, §8.3, §10.4): RouteOccurrence / TaskOccurrence (§4.8) for any
// date — live from plan.json for d >= today, from days/<d>.json.plan for d < today (R13) — with
// covered_by, the run overlay (R22 status, RunSummary, VisitSummary) and GET /api/calendar.
//
// RUN OVERLAY PLUG-IN: the overlay is computed by Calendar::overlay(), which delegates to
// Runs::overlay(array $occ, ?array $run, array $ctx): array when that method exists (Runs part).
// $occ is the occurrence (plan side, stops with seq), $run is runs[job] from the day file or null,
// $ctx = ['today' => op_date, 'users' => [id => user record]]. It must return $occ with run_status, run
// (RunSummary|null), and stops[].visit + off_plan (routes) or visit (tasks). defaultOverlay() below is
// the built-in R22 version.
final class Calendar
{
    private array $ix;
    /** @var array<int,array> */
    private array $users = [];
    /** @var array<string,list<array>> "route_id@date" => covered_by entries */
    private array $coveredRoutes = [];
    /** @var array<string,list<array>> "task_id@date" => covered_by entries */
    private array $coveredTasks = [];
    /** @var array<int,array> live route id => route */
    private array $liveRoutes = [];
    /** @var array<string,array> memo of day() */
    private array $days = [];

    public function __construct(private array $plan, private string $today, private Tx $tx)
    {
        $this->ix = Schedule::index($plan);
        foreach ($tx->get('users')['users'] ?? [] as $u) {
            $this->users[(int) $u['id']] = $u;
        }
        foreach ($plan['routes'] ?? [] as $r) {
            $this->liveRoutes[(int) $r['id']] = $r;
            $cf = $r['copied_from'] ?? null;
            if (Usage::isOneOff($r) && is_array($cf)) {
                $this->coveredRoutes[$cf['route_id'] . '@' . $cf['date']][] = ['route_id' => (int) $r['id'], 'code' => $r['code'], 'date' => $r['date']];
            }
        }
        foreach ($plan['tasks'] ?? [] as $t) {
            $cf = $t['copied_from'] ?? null;
            if (Usage::isOneOff($t) && is_array($cf)) {
                $this->coveredTasks[$cf['task_id'] . '@' . $cf['date']][] = ['task_id' => (int) $t['id'], 'date' => $t['date']];
            }
        }
    }

    public static function forCtx(Ctx $c): self
    {
        return new self($c->plan(), $c->today, $c->tx);
    }

    /**
     * Everything on date $d, already sorted per §5.8.
     * @return array{routes:list<array>,tasks:list<array>,runs:array,frozen:bool}
     */
    public function day(string $d): array
    {
        if (isset($this->days[$d])) {
            return $this->days[$d];
        }
        $frozen = $d < $this->today;
        $dayDoc = $d <= $this->today ? $this->tx->get('day:' . $d) : null;
        $routes = [];
        $tasks = [];
        if ($frozen) {
            foreach (($dayDoc['plan'] ?? null) ?: [] as $e) {
                if (($e['kind'] ?? '') === 'route') {
                    $routes[] = $this->fromFrozenRoute($e, $d);
                } elseif (($e['kind'] ?? '') === 'task') {
                    $tasks[] = $this->fromFrozenTask($e, $d);
                }
            }
        } else {
            $routes = Schedule::routesOn($this->plan, $d, $this->ix);
            $tasks = Schedule::tasksOn($this->plan, $d, $this->ix);
        }
        $runs = self::runsOf($dayDoc);
        $ctx = ['today' => $this->today, 'users' => $this->users];
        $used = [];
        foreach ($routes as $k => $o) {
            $job = 'r' . $o['route_id'];
            $used[$job] = true;
            $o['frozen'] = $frozen;
            $o['covered_by'] = $this->coveredRoutes[$o['route_id'] . '@' . $d] ?? [];
            $routes[$k] = self::overlay($o, $runs[$job] ?? null, $ctx);
        }
        foreach ($tasks as $k => $o) {
            $job = 't' . $o['task_id'];
            $used[$job] = true;
            $o['frozen'] = $frozen;
            $o['covered_by'] = $this->coveredTasks[$o['task_id'] . '@' . $d] ?? [];
            $tasks[$k] = self::overlay($o, $runs[$job] ?? null, $ctx);
        }
        // §5.6: a run whose occurrence is missing is shown as an orphan row ("plan changed"), never hidden.
        foreach ($runs as $job => $run) {
            if (isset($used[$job])) {
                continue;
            }
            $orphan = $this->orphan((string) $job, $run, $d, $frozen);
            if ($orphan !== null) {
                if ($orphan['kind'] === 'route') {
                    $routes[] = self::overlay($orphan, $run, $ctx);
                } else {
                    $tasks[] = self::overlay($orphan, $run, $ctx);
                }
            }
        }
        return $this->days[$d] = [
            'routes' => Schedule::sortRoutes($routes),
            'tasks' => Schedule::sortTasks($tasks, $this->ix),
            'runs' => $runs,
            'frozen' => $frozen,
        ];
    }

    /** One route occurrence (with overlay) or null when the route has none on $d. */
    public function routeOccurrence(int $routeId, string $d): ?array
    {
        foreach ($this->day($d)['routes'] as $o) {
            if ($o['route_id'] === $routeId && empty($o['orphan'])) {
                return $o;
            }
        }
        return null;
    }

    public function taskOccurrence(int $taskId, string $d): ?array
    {
        foreach ($this->day($d)['tasks'] as $o) {
            if ($o['task_id'] === $taskId && empty($o['orphan'])) {
                return $o;
            }
        }
        return null;
    }

    /** R22 status of today's occurrence of a job ('r5' / 't6'), or null. */
    public function todayStatus(string $job): ?string
    {
        $id = (int) substr($job, 1);
        $o = $job[0] === 'r' ? $this->routeOccurrence($id, $this->today) : $this->taskOccurrence($id, $this->today);
        return $o['run_status'] ?? null;
    }

    /**
     * Runs of a day doc keyed by job, read defensively (a list of runs with a "job" key is accepted too).
     * @return array<string,array>
     */
    public static function runsOf(?array $dayDoc): array
    {
        $out = [];
        foreach (($dayDoc['runs'] ?? null) ?: [] as $k => $run) {
            if (!is_array($run)) {
                continue;
            }
            $job = is_string($k) ? $k : (string) ($run['job'] ?? '');
            if (preg_match('/^[rt][1-9][0-9]*$/', $job)) {
                $out[$job] = $run;
            }
        }
        return $out;
    }

    private function fromFrozenRoute(array $e, string $d): array
    {
        $live = $this->liveRoutes[(int) ($e['route_id'] ?? 0)] ?? null;
        $stops = [];
        foreach ($e['stops'] ?? [] as $n => $s) {
            $stops[] = ['seq' => $n + 1, 'customer_id' => (int) $s['customer_id'], 'note' => (string) ($s['note'] ?? '')];
        }
        return array_merge([
            'key' => 'r' . ($e['route_id'] ?? 0) . '@' . $d, 'kind' => 'route', 'route_id' => 0, 'code' => '', 'color' => 1,
            'type' => 'regular', 'name' => '', 'recurring' => false, 'days' => null, 'sun' => null, 'ph' => null,
            'start' => null, 'end' => null, 'status' => 'scheduled', 'edited' => false, 'note' => '',
            'route_note' => '', 'occurrence_note' => '', 'copied_from' => null,
        ], $e, [
            'route_id' => (int) ($e['route_id'] ?? 0),
            'date' => $d,
            'rev' => $live !== null ? (int) ($live['rev'] ?? 1) : null,
            'stops' => $stops,
        ]);
    }

    private function fromFrozenTask(array $e, string $d): array
    {
        $rev = null;
        foreach ($this->plan['tasks'] ?? [] as $t) {
            if ((int) $t['id'] === (int) ($e['task_id'] ?? 0)) {
                $rev = (int) ($t['rev'] ?? 1);
            }
        }
        return array_merge([
            'key' => 't' . ($e['task_id'] ?? 0) . '@' . $d, 'kind' => 'task', 'task_id' => 0, 'waste_type' => '',
            'customer_id' => 0, 'recurring' => false, 'days' => null, 'start' => null, 'end' => null,
            'status' => 'scheduled', 'edited' => false, 'note' => '', 'task_note' => '', 'occurrence_note' => '',
            'copied_from' => null,
        ], $e, [
            'task_id' => (int) ($e['task_id'] ?? 0),
            'customer_id' => (int) ($e['customer_id'] ?? 0),
            'date' => $d,
            'rev' => $rev,
        ]);
    }

    /** An occurrence-shaped row for a run whose job is not in the plan of that date (§5.6). */
    private function orphan(string $job, array $run, string $d, bool $frozen): ?array
    {
        $id = (int) substr($job, 1);
        $base = ['date' => $d, 'frozen' => $frozen, 'orphan' => true, 'status' => 'scheduled', 'edited' => false,
            'recurring' => false, 'days' => null, 'start' => null, 'end' => null, 'note' => '', 'occurrence_note' => '',
            'rev' => null, 'copied_from' => null, 'covered_by' => []];
        if ($job[0] === 'r') {
            // The stop list is unknown: the live route's template (if the route still exists) plus visited customers.
            $r = $this->liveRoutes[$id] ?? null;
            $stops = [];
            $seen = [];
            $add = static function (int $cid, string $note) use (&$stops, &$seen): void {
                if (!isset($seen[$cid])) {
                    $seen[$cid] = true;
                    $stops[] = ['seq' => count($stops) + 1, 'customer_id' => $cid, 'note' => $note];
                }
            };
            foreach ($r === null ? [] : Schedule::filterStops($this->ix, $r['stops'] ?? []) as $s) {
                $add($s['customer_id'], $s['note']);
            }
            foreach (($run['visits'] ?? null) ?: [] as $cid => $v) {
                $add((int) ($v['customer_id'] ?? $cid), '');
            }
            return $base + ['key' => "r$id@$d", 'kind' => 'route', 'route_id' => $id, 'code' => $r['code'] ?? $job,
                'color' => (int) ($r['color'] ?? 1), 'type' => $r['type'] ?? 'regular', 'name' => (string) ($r['name'] ?? ''),
                'sun' => null, 'ph' => null, 'route_note' => '', 'stops' => $stops];
        }
        $t = null;
        foreach ($this->plan['tasks'] ?? [] as $x) {
            if ((int) $x['id'] === $id) {
                $t = $x;
            }
        }
        $cid = $t !== null ? (int) $t['customer_id'] : (int) (array_key_first($run['visits'] ?? []) ?? 0);
        return $base + ['key' => "t$id@$d", 'kind' => 'task', 'task_id' => $id, 'waste_type' => $t['waste_type'] ?? '',
            'customer_id' => $cid, 'task_note' => ''];
    }

    // ---- run overlay (R22, §4.8, §8.3) -----------------------------------------------------------

    public static function overlay(array $occ, ?array $run, array $ctx): array
    {
        static $runsOverlay = null;
        $runsOverlay ??= method_exists('Runs', 'overlay');
        if ($runsOverlay) {
            return Runs::overlay($occ, $run, $ctx);
        }
        return self::defaultOverlay($occ, $run, $ctx);
    }

    /** Built-in R22 overlay (used until the Runs part provides Runs::overlay). */
    public static function defaultOverlay(array $occ, ?array $run, array $ctx): array
    {
        $today = $ctx['today'];
        $users = $ctx['users'] ?? [];
        $date = $occ['date'];
        $visits = [];
        foreach (($run['visits'] ?? null) ?: [] as $k => $v) {
            if (is_array($v)) {
                $visits[(int) ($v['customer_id'] ?? $k)] = $v;
            }
        }
        $stopIds = $occ['kind'] === 'route' ? array_column($occ['stops'], 'customer_id') : [$occ['customer_id']];
        $c = self::counts($stopIds, $visits);
        $status = null;
        if ($run === null || ($c['resolved'] === 0 && (($run['driver_id'] ?? null) === null || $c['pending'] === 0))) {
            if ($occ['status'] === 'scheduled' || $run !== null) {
                $status = $date > $today ? 'planned' : ($date === $today ? 'not_started' : 'no_record');
            }
        } elseif ($c['pending'] === 0) {
            $status = 'done';
        } elseif ($date < $today) {
            $status = 'incomplete';
        } else {
            $status = ($run['driver_id'] ?? null) !== null ? 'active' : 'open';
        }
        $occ['run_status'] = $status;
        $occ['run'] = $run === null ? null : self::runSummary($run, $visits, $c, $users);
        if ($occ['kind'] === 'route') {
            $on = [];
            foreach ($occ['stops'] as $k => $s) {
                $on[$s['customer_id']] = true;
                $occ['stops'][$k]['visit'] = isset($visits[$s['customer_id']]) ? self::visitSummary($visits[$s['customer_id']], $users) : null;
            }
            $off = [];
            foreach ($visits as $cid => $v) {
                if (!isset($on[$cid]) && ($v['outcome'] ?? null) !== null) {
                    $off[] = ['customer_id' => $cid, 'visit' => self::visitSummary($v, $users)];
                }
            }
            $occ['off_plan'] = $off;
        } else {
            $v = $visits[$occ['customer_id']] ?? null;
            $occ['visit'] = $v === null ? null : self::visitSummary($v, $users);
        }
        return $occ;
    }

    /** @return array{collected:int,missed:int,pending:int,resolved:int,total:int} (R21) */
    public static function counts(array $stopIds, array $visits): array
    {
        $collected = $missed = $pending = 0;
        foreach ($visits as $v) {
            $o = $v['outcome'] ?? null;
            $collected += $o === 'collected' ? 1 : 0;
            $missed += $o === 'missed' ? 1 : 0;
        }
        foreach ($stopIds as $cid) {
            $o = $visits[$cid]['outcome'] ?? null;
            if ($o !== 'collected' && $o !== 'missed') {
                $pending++;
            }
        }
        $resolved = $collected + $missed;
        return ['collected' => $collected, 'missed' => $missed, 'pending' => $pending, 'resolved' => $resolved, 'total' => $pending + $resolved];
    }

    private static function userName(array $users, mixed $id): ?string
    {
        return $id === null ? null : ($users[(int) $id]['name'] ?? ('#' . $id));
    }

    /** RunSummary (§4.8). */
    public static function runSummary(array $run, array $visits, array $c, array $users): array
    {
        $holds = ($run['holds'] ?? null) ?: [];
        $driverId = $run['driver_id'] ?? null;
        $last = $holds === [] ? null : $holds[count($holds) - 1];
        $holders = [];
        $lastActivity = null;
        foreach ($holds as $h) {
            $name = self::userName($users, $h['driver_id'] ?? null);
            if ($name !== null && !in_array($name, $holders, true)) {
                $holders[] = $name;
            }
            foreach (['from', 'to'] as $f) {
                if (is_string($h[$f] ?? null) && ($lastActivity === null || strcmp($h[$f], $lastActivity) > 0)) {
                    $lastActivity = $h[$f];
                }
            }
        }
        $flagged = 0;
        foreach ($visits as $v) {
            if (is_string($v['received_at'] ?? null) && ($lastActivity === null || strcmp($v['received_at'], $lastActivity) > 0)) {
                $lastActivity = $v['received_at'];
            }
            if (!empty($v['flags'])) {
                $flagged++;
            }
        }
        $leftBy = null;
        if ($driverId === null && $last !== null && in_array($last['end'] ?? null, ['left', 'switched', 'released', 'reassigned'], true)) {
            $leftBy = self::userName($users, $last['driver_id'] ?? null);
        }
        return [
            'driver' => $driverId === null ? null : ['id' => (int) $driverId, 'name' => self::userName($users, $driverId)],
            'vehicle_no' => $last['vehicle_no'] ?? null,
            'holders' => $holders,
            'left_by' => $leftBy,
            'collected' => $c['collected'],
            'missed' => $c['missed'],
            'pending' => $c['pending'],
            'total' => $c['total'],
            'totals' => (object) self::totals($visits),
            'last_activity_at' => $lastActivity,
            'flagged' => $flagged,
        ];
    }

    /** VisitSummary (§4.8). */
    public static function visitSummary(array $v, array $users): array
    {
        return [
            'outcome' => $v['outcome'] ?? null,
            'weights' => (object) (($v['weights'] ?? null) ?: []),
            'tickets' => (object) (($v['tickets'] ?? null) ?: []),
            'reason' => $v['reason'] ?? null,
            'note' => (string) ($v['note'] ?? ''),
            'driver' => self::userName($users, $v['driver_id'] ?? null),
            'at' => $v['received_at'] ?? null,
            'rev' => (int) ($v['rev'] ?? 0),
            'flags' => array_values(($v['flags'] ?? null) ?: []),
            'photos' => count(($v['photos'] ?? null) ?: []),
            'signature' => !empty($v['signature']),
        ];
    }

    /** R32: weights summed over collected visits per waste-type code, rounded to 0.1. */
    public static function totals(array $visits): array
    {
        $sum = [];
        foreach ($visits as $v) {
            if (($v['outcome'] ?? null) !== 'collected') {
                continue;
            }
            foreach (($v['weights'] ?? null) ?: [] as $code => $w) {
                if (is_int($w) || is_float($w)) {
                    $sum[$code] = ($sum[$code] ?? 0) + $w;
                }
            }
        }
        return array_map(static fn ($x) => round((float) $x, 1), $sum);
    }

    // ---- GET /api/calendar ---------------------------------------------------------------------

    /** GET /api/calendar?view=week|month&anchor=YYYY-MM-DD (§5.9, §10.4). */
    public static function get(Ctx $c): array
    {
        $view = V::enum($c->query('view', 'week'), 'view', ['week', 'month']);
        $anchor = $c->query('anchor', '') ?: $c->today;
        V::date($anchor, 'anchor');
        $month = null;
        if ($view === 'week') {
            $from = Dates::addDays($anchor, 1 - Dates::weekday($anchor));
            $to = Dates::addDays($from, 6);
            $prev = Dates::addDays($from, -7);
            $next = Dates::addDays($from, 7);
        } else {
            $first = substr($anchor, 0, 8) . '01';
            $month = substr($anchor, 0, 7);
            $from = Dates::addDays($first, 1 - Dates::weekday($first));
            $to = Dates::addDays($from, 41);
            [$y, $m] = array_map('intval', explode('-', $month));
            $prev = sprintf('%04d-%02d-01', $m === 1 ? $y - 1 : $y, $m === 1 ? 12 : $m - 1);
            $next = sprintf('%04d-%02d-01', $m === 12 ? $y + 1 : $y, $m === 12 ? 1 : $m + 1);
        }
        $plan = $c->plan();
        $holidays = Dates::holidayMap($plan);
        $cal = new self($plan, $c->today, $c->tx);
        $days = [];
        $routes = [];
        $tasks = [];
        $cids = [];
        for ($d = $from; $d <= $to; $d = Dates::addDays($d, 1)) {
            $x = $cal->day($d);
            $past = $d < $c->today;
            $class = Dates::dayClass($d, $holidays);
            $day = [
                'date' => $d,
                'dow' => Dates::weekday($d),
                'class' => $class,
                'holiday' => $holidays[$d] ?? null,
                'past' => $past,
                'in_month' => $month === null || substr($d, 0, 7) === $month,
                'can_create' => $past ? [] : ($class === 'work' ? ['regular', 'adhoc', 'task'] : ['special', 'special_once', 'task']),
            ];
            $totals = [];
            foreach ($x['runs'] as $run) {
                foreach (self::totals(($run['visits'] ?? null) ?: []) as $code => $w) {
                    $totals[$code] = round(($totals[$code] ?? 0) + $w, 1);
                }
            }
            $day['totals'] = (object) $totals;
            if ($d <= $c->today) {
                $ops = ['not_started' => 0, 'active' => 0, 'open' => 0, 'done' => 0, 'incomplete' => 0, 'no_record' => 0];
                foreach (array_merge($x['routes'], $x['tasks']) as $o) {
                    if (isset($ops[$o['run_status'] ?? ''])) {
                        $ops[$o['run_status']]++;
                    }
                }
                $day['provisional'] = $ops['active'] + $ops['open'] > 0;
                $day['ops'] = $ops;
            } else {
                $day['provisional'] = false;
            }
            $days[] = $day;
            foreach ($x['routes'] as $o) {
                $routes[] = $o;
                foreach ($o['stops'] as $s) {
                    $cids[$s['customer_id']] = true;
                }
                foreach ($o['off_plan'] ?? [] as $s) {
                    $cids[$s['customer_id']] = true;
                }
            }
            foreach ($x['tasks'] as $o) {
                $tasks[] = $o;
                $cids[$o['customer_id']] = true;
            }
        }
        $customers = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            if (isset($cids[(int) $cu['id']])) {
                $customers[(string) $cu['id']] = Customers::out($cu);
            }
        }
        return [
            'view' => $view,
            'from' => $from,
            'to' => $to,
            'today' => $c->today,
            'prev_anchor' => $prev,
            'next_anchor' => $next,
            'missing_holiday_years' => self::missingHolidayYears($holidays, $from, $to, $c->today),
            'days' => $days,
            'routes' => $routes,
            'tasks' => $tasks,
            'customers' => (object) $customers,
        ];
    }

    /** R16: years in the visible range, or within the next 60 days, that have no holidays. */
    public static function missingHolidayYears(array $holidays, string $from, string $to, string $today): array
    {
        $years = [];
        foreach ([[$from, $to], [$today, Dates::addDays($today, 60)]] as [$a, $b]) {
            for ($y = Dates::year($a); $y <= Dates::year($b); $y++) {
                $years[$y] = true;
            }
        }
        $have = [];
        foreach (array_keys($holidays) as $d) {
            $have[Dates::year((string) $d)] = true;
        }
        $out = [];
        foreach (array_keys($years) as $y) {
            if (!isset($have[$y])) {
                $out[] = $y;
            }
        }
        sort($out);
        return $out;
    }
}
