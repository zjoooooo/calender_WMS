<?php
// Runs (R21-R26, R32, §7, §8, §10.8, §10.9): the derived job status (R22), claim (R23), leave / finish /
// release / assign and close-out (R24), driver deactivation, the run overlay used by the calendar, the
// driver's Today list and the JobDetail of one job. Result writes (R27-R30) are in src/Visits.php and
// photo/signature files (R35) in src/Files.php.
//
// Every handler runs inside the request's single locked transaction, so "the first confirm wins" (R23)
// and a switch is atomic: an ApiError rolls back every change made in the request.
//
// A run lives in days/<date>.json under runs[job] (job = 'r<route_id>'). It never copies
// the plan: its stop list is the job's occurrence on that date (frozen for past dates, live otherwise;
// Schedule::jobOccurrence), so office edits reach the driver with no sync code (§8.1).
final class Runs
{
    public const REASONS = ['no_waste', 'closed', 'no_access', 'refused', 'other', 'not_visited'];
    public const JOB_RE = '/^r[1-9][0-9]*$/';

    // ---- small pure helpers ----------------------------------------------------------------------

    /** Visits of a run keyed by int customer id (read defensively). @return array<int,array> */
    public static function visits(?array $run): array
    {
        $out = [];
        foreach (($run['visits'] ?? null) ?: [] as $k => $v) {
            if (is_array($v)) {
                $out[(int) ($v['customer_id'] ?? $k)] = $v;
            }
        }
        return $out;
    }

    /** R21 stop list (customer ids) of an occurrence: the route's effective stops. */
    public static function stopIds(?array $occ): array
    {
        if ($occ === null) {
            return [];
        }
        return array_map(static fn ($s) => (int) $s['customer_id'], $occ['stops'] ?? []);
    }

    /** R21 counts. @return array{collected:int,missed:int,pending:int,resolved:int,total:int} */
    public static function counts(array $stopIds, ?array $run): array
    {
        return Calendar::counts($stopIds, self::visits($run));
    }

    /**
     * R22 run status, derived on every read. $occStatus is the occurrence status (scheduled, cancelled,
     * holiday_skipped) or null for a run whose occurrence is missing.
     */
    public static function status(?string $occStatus, string $date, string $today, ?array $run, array $counts): ?string
    {
        $holder = $run['driver_id'] ?? null;
        if ($run === null || ($counts['resolved'] === 0 && ($holder === null || $counts['pending'] === 0))) {
            if ($run === null && $occStatus !== 'scheduled') {
                return null; // cancelled or holiday_skipped with no run
            }
            return $date > $today ? 'planned' : ($date === $today ? 'not_started' : 'no_record');
        }
        if ($counts['pending'] === 0) {
            return 'done';
        }
        if ($date < $today) {
            return 'incomplete';
        }
        return $holder !== null ? 'active' : 'open';
    }

    /** The R24 result after a release: done, not_started (nothing resolved) or open. */
    private static function resultOf(array $counts): string
    {
        return $counts['pending'] === 0 ? 'done' : ($counts['resolved'] === 0 ? 'not_started' : 'open');
    }

    public static function newRun(string $job): array
    {
        return ['job' => $job, 'driver_id' => null, 'holds' => [], 'removed' => [], 'visits' => []];
    }

    /** The open hold (to = null) of a run, or null. */
    public static function openHold(?array $run): ?array
    {
        $holds = ($run['holds'] ?? null) ?: [];
        for ($i = count($holds) - 1; $i >= 0; $i--) {
            if (($holds[$i]['to'] ?? null) === null) {
                return $holds[$i];
            }
        }
        return null;
    }

    /** The latest hold of $driverId on a run (R28 LATE uses its "from"), or null. */
    public static function lastHoldOf(?array $run, int $driverId): ?array
    {
        $holds = ($run['holds'] ?? null) ?: [];
        for ($i = count($holds) - 1; $i >= 0; $i--) {
            if ((int) ($holds[$i]['driver_id'] ?? 0) === $driverId) {
                return $holds[$i];
            }
        }
        return null;
    }

    /**
     * Closes every open hold with $end at $at and clears the holder (R24). closed_by is the principal who
     * closed it (the driver, or the office), so RunSummary.left_by can tell "left by Ali" from "taken back".
     */
    private static function closeHold(array $run, string $end, string $at, string $by): array
    {
        foreach (($run['holds'] ?? null) ?: [] as $k => $h) {
            if (($h['to'] ?? null) === null) {
                $run['holds'][$k]['to'] = $at;
                $run['holds'][$k]['end'] = $end;
                $run['holds'][$k]['closed_by'] = $by;
            }
        }
        $run['driver_id'] = null;
        return $run;
    }

    /** True when route <id> of a job key exists in the live plan. */
    public static function jobExists(array $plan, string $job): bool
    {
        $id = (int) substr($job, 1);
        foreach ($plan['routes'] ?? [] as $item) {
            if ((int) $item['id'] === $id) {
                return true;
            }
        }
        return false;
    }

    /** @return array<int,array> users.json records by id */
    public static function usersById(Ctx $c): array
    {
        $out = [];
        foreach ($c->users()['users'] ?? [] as $u) {
            $out[(int) $u['id']] = $u;
        }
        return $out;
    }

    private static function userName(array $users, mixed $id): ?string
    {
        return $id === null ? null : ($users[(int) $id]['name'] ?? ('#' . $id));
    }

    /**
     * Everything a write needs about one job: the day doc, the occurrence (frozen for past dates), the
     * stop list, the run and its counts.
     */
    private static function job(Ctx $c, array $plan, string $date, string $job): array
    {
        $day = $c->tx->get('day:' . $date);
        $occ = Schedule::jobOccurrence($plan, $day, $date, $job, $c->today);
        $run = Calendar::runsOf($day)[$job] ?? null;
        $stops = self::stopIds($occ);
        return ['day' => $day, 'occ' => $occ, 'stops' => $stops, 'run' => $run, 'counts' => self::counts($stops, $run)];
    }

    private static function jobParam(Ctx $c): string
    {
        $job = $c->param('job');
        if (!preg_match(self::JOB_RE, $job)) {
            throw new ApiError('NOT_FOUND', 404, 'job');
        }
        return $job;
    }

    // ---- run overlay for the calendar (plug-in point of Calendar::overlay) -----------------------

    /**
     * §5.6 / §4.8: attaches run_status (R22), run (RunSummary|null) and the visit summaries to one
     * occurrence: stops[].visit + off_plan. $ctx = ['today', 'users'].
     */
    public static function overlay(array $occ, ?array $run, array $ctx): array
    {
        $users = $ctx['users'] ?? [];
        $visits = self::visits($run);
        $stopIds = self::stopIds($occ);
        $counts = Calendar::counts($stopIds, $visits);
        $occ['run_status'] = self::status($occ['status'] ?? null, $occ['date'], $ctx['today'], $run, $counts);
        $occ['run'] = $run === null ? null : Calendar::runSummary($run, $visits, $counts, $users);
        $on = [];
        foreach ($occ['stops'] as $k => $s) {
            $on[$s['customer_id']] = true;
            $v = $visits[$s['customer_id']] ?? null;
            $occ['stops'][$k]['visit'] = $v === null ? null : Calendar::visitSummary($v, $users);
        }
        $off = [];
        foreach ($visits as $cid => $v) {
            if (!isset($on[$cid]) && ($v['outcome'] ?? null) !== null) {
                $off[] = ['customer_id' => $cid, 'visit' => Calendar::visitSummary($v, $users)];
            }
        }
        $occ['off_plan'] = $off;
        return $occ;
    }

    // ---- R24 core: leave / finish / release / close out ------------------------------------------

    /**
     * The R24 rule on one run of $day: with $mark ({reason, note, driver_id}) every pending stop first
     * becomes missed; then the holder is cleared and the open hold closed with end = finished when
     * pending = 0, otherwise $endIfPending. The run and its holds are always kept.
     * @return array{0:array,1:string} [the changed day doc, result]
     */
    public static function release(Ctx $c, array $plan, array $day, string $date, string $job, string $endIfPending, ?array $mark): array
    {
        $run = Calendar::runsOf($day)[$job] ?? self::newRun($job);
        $stops = self::stopIds(Schedule::jobOccurrence($plan, $day, $date, $job, $c->today));
        if ($mark !== null) {
            $visits = self::visits($run);
            foreach ($stops as $cid) {
                $prev = $visits[$cid] ?? null;
                if (in_array($prev['outcome'] ?? null, ['collected', 'missed'], true)) {
                    continue;
                }
                $run['visits'][$cid] = Visits::build($prev, $cid, [
                    'outcome' => 'missed', 'weights' => [], 'tickets' => [], 'photos' => [], 'signature' => null,
                    'reason' => $mark['reason'], 'note' => $mark['note'], 'why' => null,
                ], [
                    'by' => $c->principal(), 'driver_id' => $mark['driver_id'], 'customer' => Visits::snapshot($plan, $cid),
                    'captured_at' => null, 'received_at' => $c->nowIso, 'op_id' => null, 'flags' => [],
                ]);
            }
        }
        $counts = self::counts($stops, $run);
        if (($run['driver_id'] ?? null) !== null || self::openHold($run) !== null) {
            $run = self::closeHold($run, $counts['pending'] === 0 ? 'finished' : $endIfPending, $c->nowIso, $c->principal());
        }
        $day['runs'][$job] = $run;
        return [$day, self::resultOf($counts)];
    }

    /** {reason, note} of a mark_missed body (reason defaults to not_visited; "other" needs a note). */
    private static function missReason(array $b): array
    {
        $reason = V::enum($b['reason'] ?? 'not_visited', 'reason', self::REASONS);
        $note = ($b['note'] ?? null) === null ? '' : V::str($b['note'], 'note', 0, 500);
        if ($reason === 'other' && $note === '') {
            throw new ApiError('REASON_REQUIRED', 422, 'note');
        }
        return ['reason' => $reason, 'note' => $note];
    }

    /** finishIdleRouteHold(X) (R23 step 6, R24 assign): closes X's route holds whose pending = 0 (end = finished). */
    private static function finishIdleRouteHolds(Ctx $c, array $plan, array $day, string $date, int $driverId): array
    {
        foreach (Calendar::runsOf($day) as $job => $run) {
            if ($job[0] !== 'r' || ($run['driver_id'] ?? null) !== $driverId) {
                continue;
            }
            $stops = self::stopIds(Schedule::jobOccurrence($plan, $day, $date, $job, $c->today));
            if (self::counts($stops, $run)['pending'] === 0) {
                $day['runs'][$job] = self::closeHold($run, 'finished', $c->nowIso, $c->principal());
            }
        }
        return $day;
    }

    /** The route job X holds on $date with pending > 0 (R25), other than $except: {job, code, pending} | null. */
    private static function heldRoute(Ctx $c, array $plan, array $day, string $date, int $driverId, string $except): ?array
    {
        foreach (Calendar::runsOf($day) as $job => $run) {
            if ($job === $except || $job[0] !== 'r' || ($run['driver_id'] ?? null) !== $driverId) {
                continue;
            }
            $occ = Schedule::jobOccurrence($plan, $day, $date, $job, $c->today);
            $pending = self::counts(self::stopIds($occ), $run)['pending'];
            if ($pending > 0) {
                return ['job' => $job, 'code' => $occ['code'] ?? $job, 'pending' => $pending];
            }
        }
        return null;
    }

    /** R23 step 5: an active plate from the trucks list, upper case without spaces. */
    public static function plate(array $plan, mixed $v): string
    {
        if ($v === null || (is_string($v) && trim($v) === '')) {
            throw new ApiError('VEHICLE_REQUIRED', 422, 'vehicle_no');
        }
        if (!is_string($v)) {
            throw new ApiError('VALIDATION', 422, 'vehicle_no', null, "'vehicle_no' must be text");
        }
        $plate = Settings::normalizePlate($v);
        if (!in_array($plate, Settings::activePlates($plan), true)) {
            throw new ApiError('VEHICLE_UNKNOWN', 422, 'vehicle_no', ['plate' => $plate]);
        }
        return $plate;
    }

    // ---- driver endpoints --------------------------------------------------------------------------

    /**
     * POST /api/driver/runs/{date}/{job}/claim {vehicle_no, switch?} (R23). One locked transaction:
     * 201 created | 200 picked up / already mine: {run: JobDetail, left: null|{job, result}}.
     */
    public static function claim(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['vehicle_no', 'switch']);
        $switch = V::bool($b['switch'] ?? false, 'switch');
        $date = $c->dateParam('date');
        $job = self::jobParam($c);
        $me = (int) $c->userId();
        if ($date !== $c->today) { // 1. today only (the op_date, R1)
            throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
        }
        $plan = $c->plan();
        if (!self::jobExists($plan, $job)) {
            throw new ApiError('NOT_FOUND', 404, 'job');
        }
        $j = self::job($c, $plan, $date, $job);
        $day = $j['day'];
        $run = $j['run'];
        $holder = $run['driver_id'] ?? null;
        $users = self::usersById($c);

        if ($holder === $me) { // 2. already mine: 200, the plate is updated when one is sent
            if (array_key_exists('vehicle_no', $b) && $b['vehicle_no'] !== null) {
                $plate = self::plate($plan, $b['vehicle_no']);
                for ($i = count($run['holds']) - 1; $i >= 0; $i--) {
                    if (($run['holds'][$i]['to'] ?? null) === null) {
                        $run['holds'][$i]['vehicle_no'] = $plate;
                        break;
                    }
                }
                $day['runs'][$job] = $run;
                $c->tx->put('day:' . $date, $day);
            }
            return ['run' => self::detail($c, $date, $job, false), 'left' => null];
        }
        if ($holder !== null && $j['counts']['pending'] > 0) { // 3. another driver holds it (R25)
            $hold = self::openHold($run);
            throw new ApiError('RUN_TAKEN', 409, null, [
                'driver' => self::userName($users, $holder), 'since' => $hold['from'] ?? null,
                'collected' => $j['counts']['collected'], 'total' => $j['counts']['total'],
            ]);
        }
        if ($j['occ'] === null || ($j['occ']['status'] ?? null) !== 'scheduled' || $j['counts']['pending'] < 1) {
            throw new ApiError('NOT_RUNNABLE', 422); // 4. scheduled with pending >= 1 (done jobs too)
        }
        $plate = self::plate($plan, $b['vehicle_no'] ?? null); // 5.

        $left = null;
        if ($job[0] === 'r') { // 6. finish idle holds, then one route at a time
            $day = self::finishIdleRouteHolds($c, $plan, $day, $date, $me);
            $other = self::heldRoute($c, $plan, $day, $date, $me, $job);
            if ($other !== null) {
                if (!$switch) {
                    throw new ApiError('DRIVER_HAS_ACTIVE_RUN', 409, null, $other);
                }
                [$day, $result] = self::release($c, $plan, $day, $date, $other['job'], 'switched', null);
                $left = ['job' => $other['job'], 'result' => $result];
            }
        }

        $created = $run === null; // 8. create or reuse the run, append the hold
        $run = Calendar::runsOf($day)[$job] ?? self::newRun($job);
        $run['holds'][] = ['driver_id' => $me, 'vehicle_no' => $plate, 'by' => 'self', 'from' => $c->nowIso, 'to' => null, 'end' => null];
        $run['driver_id'] = $me;
        $day['runs'][$job] = $run;
        $c->tx->put('day:' . $date, $day);
        if ($created) {
            $c->status = 201;
        }
        return ['run' => self::detail($c, $date, $job, false), 'left' => $left];
    }

    /**
     * POST /api/driver/runs/{date}/{job}/release {mark_missed, reason?, note?} (R24): leave / give back /
     * finish by the holder, only while the run's date is today. -> {result}
     */
    public static function driverRelease(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['mark_missed', 'reason', 'note']);
        $mark = V::bool($b['mark_missed'] ?? false, 'mark_missed');
        $date = $c->dateParam('date');
        $job = self::jobParam($c);
        if ($date !== $c->today) {
            throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
        }
        $me = (int) $c->userId();
        $plan = $c->plan();
        $j = self::job($c, $plan, $date, $job);
        if ($j['run'] === null || ($j['run']['driver_id'] ?? null) !== $me) {
            throw new ApiError('NOT_HOLDER', 409);
        }
        // mark_missed is ignored when nothing is pending (Finish)
        $m = ($mark && $j['counts']['pending'] > 0) ? self::missReason($b) + ['driver_id' => $me] : null;
        [$day, $result] = self::release($c, $plan, $j['day'], $date, $job, 'left', $m);
        $c->tx->put('day:' . $date, $day);
        return ['result' => $result];
    }

    /** GET /api/driver/runs/{date}/{job} -> JobDetail (today's jobs only, §12). */
    public static function driverGet(Ctx $c): array
    {
        $date = $c->dateParam('date');
        $job = self::jobParam($c);
        if ($date !== $c->today) {
            throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
        }
        return self::detail($c, $date, $job, false);
    }

    /** GET /api/driver/today (§10.9): today's (op_date) route cards plus the driver's own route. */
    public static function driverToday(Ctx $c): array
    {
        $me = (int) $c->userId();
        $plan = $c->plan();
        $ix = Schedule::index($plan);
        $x = Calendar::forCtx($c)->day($c->today);
        $users = self::usersById($c);
        $name = static fn (int $cid) => (string) ($ix['customers'][$cid]['name'] ?? ('#' . $cid));
        $rank = ['open' => 0, 'not_started' => 1, 'active' => 2, 'done' => 3];

        $routes = [];
        $myRoute = null;
        foreach ($x['routes'] as $o) {
            $job = 'r' . $o['route_id'];
            $run = $x['runs'][$job] ?? null;
            if (!empty($o['orphan']) || $o['status'] !== 'scheduled' || ($o['stops'] === [] && $run === null)) {
                continue;
            }
            $sum = $o['run'];
            $pending = $sum['pending'] ?? count($o['stops']);
            $routes[] = [
                'job' => $job, 'date' => $c->today, 'code' => $o['code'], 'color' => $o['color'], 'type' => $o['type'],
                'waste_type' => $o['waste_type'], 'name' => $o['name'], 'note' => $o['note'], 'stops' => count($o['stops']),
                'first_customers' => array_map(static fn ($s) => $name($s['customer_id']), array_slice($o['stops'], 0, 3)),
                'status' => $o['run_status'], 'driver' => $sum['driver'] ?? null, 'left_by' => $sum['left_by'] ?? null,
                'released_by_office' => $sum['released_by_office'] ?? false,
                'collected' => $sum['collected'] ?? 0, 'missed' => $sum['missed'] ?? 0, 'pending' => $pending,
                'can_take' => in_array($o['run_status'], ['not_started', 'open'], true) && $pending >= 1,
            ];
            if ($run !== null && ($run['driver_id'] ?? null) === $me && ($myRoute === null || $myRoute['pending'] === 0)) {
                $hold = self::openHold($run);
                $myRoute = ['date' => $c->today, 'job' => $job, 'code' => $o['code'], 'name' => $o['name'],
                    'pending' => $pending, 'total' => $sum['total'] ?? $pending, 'vehicle_no' => $hold['vehicle_no'] ?? null,
                    'assigned' => ($hold['by'] ?? 'self') !== 'self'];
            }
        }
        usort($routes, static fn ($a, $b) => ($rank[$a['status']] ?? 9) <=> ($rank[$b['status']] ?? 9)
            ?: strnatcasecmp($a['code'], $b['code']) ?: strcmp($a['job'], $b['job']));

        $u = $users[$me] ?? $c->user;
        return [
            'today' => $c->today,
            'now' => $c->nowIso,
            'day_ends_at' => Clock::iso(Clock::dayEnd($c->today, $c->rollover)),
            'me' => ['id' => $me, 'name' => $u['name'], 'lang' => $u['lang']],
            'my_route' => $myRoute,
            'waste_types' => array_values(array_filter($plan['waste_types'] ?? [], static fn ($t) => !empty($t['active']))),
            'trucks' => Settings::activePlates($plan),
            'routes' => $routes,
        ];
    }

    // ---- office endpoints --------------------------------------------------------------------------

    /** GET /api/runs/{date}/{job} -> JobDetail + holds + removed + full visits with history (any date). */
    public static function get(Ctx $c): array
    {
        return self::detail($c, $c->dateParam('date'), self::jobParam($c), true);
    }

    /**
     * POST /api/runs/{date}/{job}/release {mark_missed:false} | {mark_missed:true, reason?, note?} (R24, §6.12).
     * mark_missed=false: Release (today, the job must have a holder; end = released).
     * mark_missed=true: Close out (any date <= today): every pending stop missed (default not_visited);
     * on a scheduled job with no run it creates a holder-less run (R21). -> {result}
     */
    public static function officeRelease(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['mark_missed', 'reason', 'note']);
        $mark = V::bool($b['mark_missed'] ?? false, 'mark_missed');
        $date = $c->dateParam('date');
        $job = self::jobParam($c);
        if ($date > $c->today || (!$mark && $date !== $c->today)) {
            throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
        }
        $plan = $c->plan();
        $j = self::job($c, $plan, $date, $job);
        $day = $j['day'];
        if (!$mark) {
            if ($j['run'] === null || ($j['run']['driver_id'] ?? null) === null) {
                throw new ApiError('NOT_HOLDER', 409, null, null, 'This job has no driver to release');
            }
            [$day, $result] = self::release($c, $plan, $day, $date, $job, 'released', null);
        } else {
            $m = self::missReason($b) + ['driver_id' => null];
            if ($j['run'] === null) {
                if ($j['occ'] === null) {
                    throw new ApiError('NOT_FOUND', 404, 'job');
                }
                if (($j['occ']['status'] ?? null) !== 'scheduled') {
                    throw new ApiError('NOT_RUNNABLE', 422);
                }
            }
            [$day, $result] = self::release($c, $plan, $day, $date, $job, 'released', $m);
        }
        $c->tx->put('day:' . $date, $day);
        return ['result' => $result];
    }

    /**
     * POST /api/runs/{date}/{job}/assign {driver_id, switch?} (R24, T3): today only, scheduled with pending >= 1.
     * -> {run: RunSummary, gave_back: null|{job, result}} | 409 DRIVER_HAS_ACTIVE_RUN
     */
    public static function assign(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['driver_id', 'switch']);
        $x = V::id($b['driver_id'] ?? null, 'driver_id');
        $switch = V::bool($b['switch'] ?? false, 'switch');
        $date = $c->dateParam('date');
        $job = self::jobParam($c);
        if ($date !== $c->today) {
            throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
        }
        $plan = $c->plan();
        if (!self::jobExists($plan, $job)) {
            throw new ApiError('NOT_FOUND', 404, 'job');
        }
        $users = self::usersById($c);
        $target = $users[$x] ?? null;
        if ($target === null || $target['role'] !== 'driver' || empty($target['active'])) {
            throw new ApiError('VALIDATION', 422, 'driver_id', null, 'Pick an active driver');
        }
        $j = self::job($c, $plan, $date, $job);
        if ($j['occ'] === null || ($j['occ']['status'] ?? null) !== 'scheduled' || $j['counts']['pending'] < 1) {
            throw new ApiError('NOT_RUNNABLE', 422);
        }
        $day = $j['day'];
        $holder = $j['run']['driver_id'] ?? null;
        $gave = null;
        if ($holder !== $x) {
            if ($job[0] === 'r') {
                $day = self::finishIdleRouteHolds($c, $plan, $day, $date, $x);
                $other = self::heldRoute($c, $plan, $day, $date, $x, $job);
                if ($other !== null) {
                    if (!$switch) {
                        throw new ApiError('DRIVER_HAS_ACTIVE_RUN', 409, null, $other);
                    }
                    [$day, $result] = self::release($c, $plan, $day, $date, $other['job'], 'switched', null);
                    $gave = ['job' => $other['job'], 'result' => $result];
                }
            }
            $run = Calendar::runsOf($day)[$job] ?? self::newRun($job);
            if ($holder !== null) {
                $run = self::closeHold($run, 'reassigned', $c->nowIso, $c->principal());
            }
            $run['holds'][] = ['driver_id' => $x, 'vehicle_no' => null, 'by' => $c->principal(), 'from' => $c->nowIso, 'to' => null, 'end' => null];
            $run['driver_id'] = $x;
            $day['runs'][$job] = $run;
            $c->tx->put('day:' . $date, $day);
        }
        $run = Calendar::runsOf($day)[$job];
        $visits = self::visits($run);
        return ['run' => Calendar::runSummary($run, $visits, Calendar::counts($j['stops'], $visits), $users), 'gave_back' => $gave];
    }

    /**
     * Hooks::USER_DEACTIVATED (R24): deactivating a driver, or changing their role away from driver, releases
     * every job they hold today (end = released).
     */
    public static function onUserDeactivated(Ctx $c, array $user): void
    {
        $date = $c->today;
        $plan = $c->plan();
        $day = $c->tx->get('day:' . $date);
        $changed = false;
        foreach (Calendar::runsOf($day) as $job => $run) {
            if (($run['driver_id'] ?? null) === (int) $user['id']) {
                [$day] = self::release($c, $plan, $day, $date, (string) $job, 'released', null);
                $changed = true;
            }
        }
        if ($changed) {
            $c->tx->put('day:' . $date, $day);
        }
    }

    // ---- JobDetail (§10.9; office: + holds, removed, visits) ---------------------------------------

    /** JobDetail of one job on $date: the same shape before a claim and during the run. */
    public static function detail(Ctx $c, string $date, string $job, bool $office): array
    {
        $plan = $c->plan();
        $ix = Schedule::index($plan);
        $x = Calendar::forCtx($c)->day($date);
        $id = (int) substr($job, 1);
        $occ = null;
        foreach ($x['routes'] as $o) {
            if ((int) $o['route_id'] === $id) {
                $occ = $o;
                break;
            }
        }
        if ($occ === null) {
            throw new ApiError('NOT_FOUND', 404, 'job', null, 'This job does not exist on this date');
        }
        $run = $x['runs'][$job] ?? null;
        $visits = self::visits($run);
        $users = self::usersById($c);
        $holder = $run['driver_id'] ?? null;
        $hold = self::openHold($run);

        $stops = [];
        foreach ($occ['stops'] as $s) {
            $stops[] = self::jobStop($ix, $x, $job, $occ, (int) $s['seq'], (int) $s['customer_id'], (string) $s['note'], true, $visits);
        }
        foreach ($occ['off_plan'] ?? [] as $op) {
            $stops[] = self::jobStop($ix, $x, $job, $occ, count($stops) + 1, (int) $op['customer_id'], '', false, $visits);
        }
        $counts = Calendar::counts(self::stopIds($occ), $visits);
        $out = [
            'date' => $date,
            'job' => $job,
            'kind' => 'route',
            'code' => $occ['code'],
            'color' => $occ['color'],
            'type' => $occ['type'],
            'name' => $occ['name'],
            'note' => (string) ($occ['note'] ?? ''),
            'waste_type' => $occ['waste_type'], // the one type this route collects
            'plan_status' => $occ['status'],
            'status' => $occ['run_status'],
            'holder' => $holder === null ? null : ['id' => (int) $holder, 'name' => self::userName($users, $holder)],
            'mine' => !$office && $holder !== null && (int) $holder === $c->userId(),
            'vehicle_no' => $hold['vehicle_no'] ?? null,
            'progress' => ['collected' => $counts['collected'], 'missed' => $counts['missed'], 'pending' => $counts['pending'], 'total' => $counts['total']],
            'totals' => (object) Calendar::totals($visits),
            'stops' => $stops,
        ];
        if ($office) {
            $out['run'] = $occ['run'];
            $out['holds'] = array_values(($run['holds'] ?? null) ?: []);
            $out['removed'] = array_values(($run['removed'] ?? null) ?: []);
            $full = [];
            foreach ($visits as $cid => $v) {
                $full[(string) $cid] = Visits::publicVisit($v, true);
            }
            $out['visits'] = (object) $full;
        }
        return $out;
    }

    private static function jobStop(array $ix, array $x, string $job, array $occ, int $seq, int $cid, string $note, bool $onPlan, array $visits): array
    {
        $cu = $ix['customers'][$cid] ?? null;
        $weigh = Visits::routeWeighTypes($ix['types'], (string) $occ['waste_type']);
        $v = $visits[$cid] ?? null;
        return [
            'seq' => $seq,
            'on_plan' => $onPlan,
            'stop_note' => $note,
            'customer' => ['id' => $cid, 'code' => (string) ($cu['code'] ?? ''), 'name' => (string) ($cu['name'] ?? ''),
                'address' => (string) ($cu['address'] ?? ''), 'phone' => (string) ($cu['phone'] ?? ''), 'note' => (string) ($cu['note'] ?? '')],
            'weigh_types' => $weigh,
            'ticket_types' => array_values(array_filter($weigh, static fn ($t) => ($ix['types'][$t]['weigh_method'] ?? '') === 'weighbridge')),
            'also_on' => self::alsoOn($x, $job, $cid),
            'visit' => $v === null ? null : [
                'outcome' => $v['outcome'] ?? null, 'weights' => (object) (($v['weights'] ?? null) ?: []),
                'tickets' => (object) (($v['tickets'] ?? null) ?: []), 'photos' => array_values(($v['photos'] ?? null) ?: []),
                'signature' => $v['signature'] ?? null, 'reason' => $v['reason'] ?? null, 'note' => (string) ($v['note'] ?? ''),
                'driver_id' => $v['driver_id'] ?? null, 'rev' => (int) ($v['rev'] ?? 0), 'captured_at' => $v['captured_at'] ?? null,
                'flags' => array_values(($v['flags'] ?? null) ?: []),
            ],
        ];
    }

    /** R31: the other routes that day for the same customer: [{job, kind, label (route code), outcome}]. */
    private static function alsoOn(array $x, string $job, int $cid): array
    {
        $out = [];
        foreach ($x['routes'] as $o) {
            $j = 'r' . $o['route_id'];
            if ($j === $job || !empty($o['orphan']) || ($o['status'] !== 'scheduled' && $o['run'] === null)) {
                continue;
            }
            foreach ($o['stops'] as $s) {
                if ((int) $s['customer_id'] === $cid) {
                    $out[] = ['job' => $j, 'kind' => 'route', 'label' => $o['code'], 'outcome' => $s['visit']['outcome'] ?? null];
                    break;
                }
            }
        }
        return $out;
    }
}
