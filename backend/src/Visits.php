<?php
// Result writes (visits) for drivers and the office (R27-R31, §7.6, §10.8, §10.9):
//   PUT /api/driver/runs/{date}/{job}/stops/{customer_id}   (driver: R28 holder, job, edit window, LATE)
//   PUT /api/runs/{date}/{job}/stops/{customer_id}          (office: R29 why, OFFICE_EDITED, back-fill)
// Order of checks: R30 replay by op_id FIRST (so a retry never turns into NOT_HOLDER or EDIT_WINDOW_CLOSED),
// then R28/R29 (holder, job, edit window, why), then the R27 content, then the R28/R30 conflict rules,
// then the write (rev + 1, the previous version appended to history).
// A conflict (409 VISIT_CHANGED) is COMMITTED: the rejected body goes into history with rejected = true and
// the visit gets the CONFLICT flag, so no weight is ever lost.
final class Visits
{
    public const OP_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';
    public const MAX_OPS = 20;
    public const MAX_WEIGHT = 99999.9;

    public static function driverWrite(Ctx $c): array
    {
        return self::write($c, false);
    }

    public static function officeWrite(Ctx $c): array
    {
        return self::write($c, true);
    }

    private static function write(Ctx $c, bool $office): array
    {
        $b = $c->body;
        V::only($b, ['op_id', 'base_rev', 'outcome', 'weights', 'tickets', 'photos', 'signature', 'reason', 'note',
            'captured_at', 'why', 'driver_id']);
        $date = $c->dateParam('date');
        $job = $c->param('job');
        if (!preg_match(Runs::JOB_RE, $job)) {
            throw new ApiError('NOT_FOUND', 404, 'job');
        }
        $cid = $c->intParam('cid');
        $opId = is_string($b['op_id'] ?? null) ? strtolower($b['op_id']) : '';
        if (!preg_match(self::OP_RE, $opId)) {
            throw new ApiError('VALIDATION', 422, 'op_id', null, "'op_id' must be a UUID");
        }
        $baseRev = V::int($b['base_rev'] ?? null, 'base_rev', 0);
        if (!array_key_exists('outcome', $b)) {
            throw new ApiError('VALIDATION', 422, 'outcome', null, "Missing field 'outcome'");
        }
        $me = (int) $c->userId();
        $principal = $c->principal();
        $plan = $c->plan();
        $doc = 'day:' . $date;
        $day = $c->tx->get($doc);
        $run = Calendar::runsOf($day)[$job] ?? null;
        $prev = Runs::visits($run)[$cid] ?? null;

        // R30 step 1: a replay returns the recorded result and changes nothing.
        foreach (($prev['ops'] ?? null) ?: [] as $op) {
            if (($op['op_id'] ?? null) === $opId) {
                if (($op['result'] ?? '') === 'applied') {
                    return self::response($c, $plan, $day, $date, $job, $prev, $office, true);
                }
                throw new ApiError('VISIT_CHANGED', 409, null, ['visit' => self::publicVisit($prev, $office)]);
            }
        }

        $occ = Schedule::jobOccurrence($plan, $day, $date, $job, $c->today);
        $kind = $job[0] === 'r' ? 'route' : 'task';
        if (!$office && ($run === null || Runs::lastHoldOf($run, $me) === null)) {
            throw new ApiError('NOT_HOLDER', 409); // R28: the driver must appear in run.holds
        }
        if ($office && $run === null) { // R29 back-fill: a scheduled job dated <= today
            if ($date > $c->today) {
                throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today]);
            }
            if ($occ === null) {
                throw new ApiError('NOT_FOUND', 404, 'job');
            }
            if (($occ['status'] ?? null) !== 'scheduled') {
                throw new ApiError('NOT_RUNNABLE', 422);
            }
        }

        // R28 NOT_ON_JOB / OFF_PLAN
        $ix = Schedule::index($plan);
        $customer = $ix['customers'][$cid] ?? null;
        $offPlan = false;
        $taskType = null;
        if ($kind === 'task') {
            [$taskCid, $taskType] = self::taskOf($plan, $occ, $job, $run);
            if ($cid !== $taskCid || $customer === null) {
                throw new ApiError('NOT_ON_JOB', 422, 'customer_id');
            }
        } elseif (!in_array($cid, Runs::stopIds($occ), true)) {
            $removed = array_map('intval', ($run['removed'] ?? null) ?: []);
            $ok = $prev !== null || in_array($cid, $removed, true);
            if ($office && !$ok) { // R29: the office may record any routable customer as OFF_PLAN
                $ok = $customer !== null && Usage::customerRoutable($customer, $ix['types']);
            }
            if (!$ok || $customer === null) {
                throw new ApiError('NOT_ON_JOB', 422, 'customer_id');
            }
            $offPlan = true;
        }

        $changing = $prev !== null && ($prev['outcome'] ?? null) !== null;
        if (!$office && $changing && $c->now >= Clock::editDeadline($date, $c->rollover, (int) $c->config('driver_edit_grace_hours'))) {
            throw new ApiError('EDIT_WINDOW_CLOSED', 422, null, ['deadline' => Clock::iso(Clock::editDeadline($date, $c->rollover,
                (int) $c->config('driver_edit_grace_hours')))]);
        }
        $why = null;
        $bodyDriver = null;
        if ($office) {
            $why = ($b['why'] ?? null) === null ? '' : V::str($b['why'], 'why', 0, 200);
            if ($changing && $why === '') {
                throw new ApiError('WHY_REQUIRED', 422, 'why');
            }
            $why = $why === '' ? null : $why;
            if (($b['driver_id'] ?? null) !== null) {
                $bodyDriver = V::id($b['driver_id'], 'driver_id');
                $u = Runs::usersById($c)[$bodyDriver] ?? null;
                if ($u === null || $u['role'] !== 'driver') {
                    throw new ApiError('VALIDATION', 422, 'driver_id', null, 'Pick a driver');
                }
            }
        }
        $values = self::values($c, $b, $ix['types'], $kind, $taskType, $customer, $offPlan) + ['why' => $why];
        $cap = Clock::parse($b['captured_at'] ?? null);

        if ($values['outcome'] === null && !$changing) {
            return self::response($c, $plan, $day, $date, $job, $prev, $office, false); // undo of a pending stop: nothing to do
        }

        // R28 (a driver changes only a pending stop or a visit they wrote last) and R30 steps 2-4.
        $last = $prev['by'] ?? null;
        $conflict = $prev !== null && (
            (!$office && $changing && $last !== $principal)
            || ($baseRev !== (int) ($prev['rev'] ?? 0) && $last !== $principal)
        );
        if ($conflict) {
            $prev['history'][] = ['rev' => (int) $prev['rev'], 'at' => $c->nowIso, 'by' => $principal, 'op_id' => $opId, 'base_rev' => $baseRev]
                + self::versionOf($values) + ['driver_id' => $office ? $bodyDriver : $me, 'rejected' => true];
            $prev['flags'] = array_values(array_unique(array_merge(($prev['flags'] ?? null) ?: [], ['CONFLICT'])));
            $prev['ops'] = array_slice(array_merge(($prev['ops'] ?? null) ?: [], [['op_id' => $opId, 'result' => 'rejected']]), -self::MAX_OPS);
            $run['visits'][$cid] = $prev;
            $day['runs'][$job] = $run;
            $c->tx->put($doc, $day);
            throw (new ApiError('VISIT_CHANGED', 409, null, ['visit' => self::publicVisit($prev, $office)]))->committing();
        }

        $run ??= Runs::newRun($job);
        $flags = [];
        if ($offPlan) {
            $flags[] = 'OFF_PLAN';
        }
        if ($office && $changing) {
            $flags[] = 'OFFICE_EDITED';
        }
        if (!$office && self::isLate($c, $run, $me, $date, $cap)) {
            $flags[] = 'LATE';
        }
        $driverId = $office
            ? ((!$changing && $bodyDriver !== null) ? $bodyDriver : ($prev['driver_id'] ?? ($run['driver_id'] ?? null)))
            : $me;
        $visit = self::build($prev, $cid, $values, [
            'by' => $principal, 'driver_id' => $driverId, 'customer' => self::snapshot($plan, $cid),
            'captured_at' => $cap === null ? null : Clock::iso($cap), 'received_at' => $c->nowIso, 'op_id' => $opId, 'flags' => $flags,
        ]);
        $run['visits'][$cid] = $visit;
        $day['runs'][$job] = $run;
        $c->tx->put($doc, $day);
        foreach (['OFF_PLAN', 'LATE'] as $w) {
            if (in_array($w, $flags, true)) {
                $c->warn($w);
            }
        }
        return self::response($c, $plan, $day, $date, $job, $visit, $office, false);
    }

    /** Driver: {visit, progress, totals, replay}. Office: {visit (with history), run: RunSummary, replay}. */
    private static function response(Ctx $c, array $plan, array $day, string $date, string $job, ?array $visit, bool $office, bool $replay): array
    {
        $occ = Schedule::jobOccurrence($plan, $day, $date, $job, $c->today);
        $run = Calendar::runsOf($day)[$job] ?? null;
        $visits = Runs::visits($run);
        $counts = Calendar::counts(Runs::stopIds($occ), $visits);
        if ($office) {
            return ['visit' => self::publicVisit($visit, true),
                'run' => $run === null ? null : Calendar::runSummary($run, $visits, $counts, Runs::usersById($c)), 'replay' => $replay];
        }
        return [
            'visit' => self::publicVisit($visit, false),
            'progress' => ['collected' => $counts['collected'], 'missed' => $counts['missed'], 'pending' => $counts['pending'], 'total' => $counts['total']],
            'totals' => (object) Calendar::totals($visits),
            'replay' => $replay,
        ];
    }

    /** [customer_id, waste_type] of a task job (the occurrence, else the live task, else the run's visit). */
    private static function taskOf(array $plan, ?array $occ, string $job, ?array $run): array
    {
        if ($occ !== null) {
            return [(int) $occ['customer_id'], (string) $occ['waste_type']];
        }
        foreach ($plan['tasks'] ?? [] as $t) {
            if ((int) $t['id'] === (int) substr($job, 1)) {
                return [(int) $t['customer_id'], (string) $t['waste_type']];
            }
        }
        $first = array_key_first(Runs::visits($run));
        return [$first === null ? 0 : (int) $first, ''];
    }

    /**
     * R27 weighable types of a route stop: the customer's registered, active, routable types (waste-type
     * order). An OFF_PLAN customer with none left may be weighed in any active routable type.
     * @param array<string,array> $types Usage::typesByCode()
     */
    public static function routeWeighTypes(array $types, ?array $customer, bool $offPlan): array
    {
        $own = [];
        $all = [];
        foreach ($types as $code => $t) {
            if (!empty($t['routable']) && !empty($t['active'])) {
                $all[] = (string) $code;
                if (in_array((string) $code, ($customer['waste_types'] ?? null) ?: [], true)) {
                    $own[] = (string) $code;
                }
            }
        }
        return ($own === [] && $offPlan) ? $all : $own;
    }

    /** R27 content of a write: {outcome, weights, tickets, photos, signature, reason, note}. */
    private static function values(Ctx $c, array $b, array $types, string $kind, ?string $taskType, ?array $customer, bool $offPlan): array
    {
        $outcome = $b['outcome'];
        if ($outcome !== null && $outcome !== 'collected' && $outcome !== 'missed') {
            throw new ApiError('VALIDATION', 422, 'outcome', null, "'outcome' must be collected, missed or null");
        }
        if ($outcome === null) { // undo: the stop is pending again
            return ['outcome' => null, 'weights' => [], 'tickets' => [], 'photos' => [], 'signature' => null, 'reason' => null, 'note' => ''];
        }
        $weighable = $kind === 'task' ? [(string) $taskType] : self::routeWeighTypes($types, $customer, $offPlan);
        $weightsIn = self::map($b['weights'] ?? [], 'weights');
        $ticketsIn = self::map($b['tickets'] ?? [], 'tickets');
        $note = ($b['note'] ?? null) === null ? '' : V::str($b['note'], 'note', 0, 500);

        $blobs = new Blobs($c->dataDir());
        $photos = [];
        foreach (V::list($b['photos'] ?? [], 'photos') as $n => $ref) {
            $p = self::fileRef($ref, "photos.$n", $blobs);
            if (!in_array($p, $photos, true)) {
                $photos[] = $p;
            }
        }
        if (count($photos) > (int) $c->config('max_photos')) {
            throw new ApiError('VALIDATION', 422, 'photos', null, 'At most ' . (int) $c->config('max_photos') . ' photos');
        }
        $signature = ($b['signature'] ?? null) === null ? null : self::fileRef($b['signature'], 'signature', $blobs);

        $weights = [];
        $tickets = [];
        $reason = null;
        if ($outcome === 'collected') {
            foreach ($weightsIn as $code => $raw) {
                $code = (string) $code;
                if (!in_array($code, $weighable, true)) {
                    throw new ApiError('TYPE_NOT_ALLOWED', 422, "weights.$code", ['allowed' => $weighable]);
                }
                $w = self::weight($raw);
                if ($w === null) {
                    throw new ApiError('WEIGHT_INVALID', 422, "weights.$code");
                }
                $weights[$code] = $w;
            }
            if (array_filter($weights, static fn ($w) => $w > 0) === []) {
                throw new ApiError('WEIGHT_REQUIRED', 422, 'weights');
            }
            foreach ($ticketsIn as $code => $t) {
                $code = (string) $code;
                if (!in_array($code, $weighable, true)) {
                    throw new ApiError('TYPE_NOT_ALLOWED', 422, "tickets.$code", ['allowed' => $weighable]);
                }
                if (($types[$code]['weigh_method'] ?? 'on_site') !== 'weighbridge' || $t === null) {
                    continue; // tickets are dropped for on-site types
                }
                $t = V::str($t, "tickets.$code", 0, 30);
                if ($t !== '') {
                    $tickets[$code] = $t;
                }
            }
            foreach ($weighable as $code) {
                if (($types[$code]['weigh_method'] ?? 'on_site') === 'weighbridge' && ($weights[$code] ?? 0) > 0 && !isset($tickets[$code])) {
                    throw new ApiError('TICKET_REQUIRED', 422, "tickets.$code");
                }
            }
        } else {
            if (($b['reason'] ?? null) === null) {
                throw new ApiError('VALIDATION', 422, 'reason', null, 'Pick a reason');
            }
            $reason = V::enum($b['reason'], 'reason', Runs::REASONS);
            if ($reason === 'other' && trim($note) === '') {
                throw new ApiError('REASON_REQUIRED', 422, 'note');
            }
            foreach ($weightsIn as $code => $raw) {
                if (self::weight($raw) !== 0.0) {
                    throw new ApiError('VALIDATION', 422, "weights.$code", null, 'A missed stop has no weights');
                }
            }
            foreach ($ticketsIn as $code => $t) {
                if ($t !== null && $t !== '') {
                    throw new ApiError('VALIDATION', 422, "tickets.$code", null, 'A missed stop has no tickets');
                }
            }
        }
        return ['outcome' => $outcome, 'weights' => $weights, 'tickets' => $tickets, 'photos' => $photos,
            'signature' => $signature, 'reason' => $reason, 'note' => $note];
    }

    /** A JSON object (or an empty list) as an array. */
    private static function map(mixed $v, string $field): array
    {
        if (!is_array($v) || ($v !== [] && array_is_list($v))) {
            throw new ApiError('VALIDATION', 422, $field, null, "'$field' must be an object {code: value}");
        }
        return $v;
    }

    /** R27: 0-99999.9 with at most 1 decimal; "," is accepted as the decimal separator. Null when invalid. */
    public static function weight(mixed $raw): ?float
    {
        if (is_string($raw)) {
            $s = str_replace(',', '.', trim($raw));
            if (!preg_match('/^\d{1,5}(\.\d)?$/', $s)) {
                return null;
            }
            $v = (float) $s;
        } elseif (is_int($raw) || is_float($raw)) {
            $v = (float) $raw;
            if (!is_finite($v) || abs($v * 10 - round($v * 10)) > 1e-6) {
                return null;
            }
        } else {
            return null;
        }
        if ($v < 0 || $v > self::MAX_WEIGHT) {
            return null;
        }
        return round($v, 1);
    }

    /** A file reference '<uuid>.jpg|png' (or its stored path) -> stored path; FILE_MISSING when not uploaded. */
    private static function fileRef(mixed $v, string $field, Blobs $blobs): string
    {
        $name = is_string($v) ? $v : '';
        if (preg_match('#^files/[0-9a-f]{2}/([^/]+)$#', $name, $m)) {
            $name = $m[1];
        }
        $p = Blobs::parseName($name);
        if ($p === null || (is_string($v) && str_contains($v, '/') && $v !== Blobs::relPath($p[0], $p[1]))) {
            throw new ApiError('VALIDATION', 422, $field, null, 'Expected a file name <uuid>.jpg or <uuid>.png');
        }
        $path = Blobs::relPath($p[0], $p[1]);
        if (!$blobs->exists($path)) {
            throw new ApiError('FILE_MISSING', 422, $field, ['file' => $name]);
        }
        return $path;
    }

    /** R28 LATE: the writer is not run.driver_id, or the effective time t >= day_end(run date). */
    private static function isLate(Ctx $c, array $run, int $me, string $date, ?DateTimeImmutable $captured): bool
    {
        if (($run['driver_id'] ?? null) !== $me) {
            return true;
        }
        $from = Clock::parse(Runs::lastHoldOf($run, $me)['from'] ?? null);
        $t = ($captured !== null && $from !== null && $from <= $captured && $captured <= $c->now) ? $captured : $c->now;
        return $t >= Clock::dayEnd($date, $c->rollover);
    }

    /** The customer snapshot stored on a visit. */
    public static function snapshot(array $plan, int $cid): array
    {
        foreach ($plan['customers'] ?? [] as $cu) {
            if ((int) $cu['id'] === $cid) {
                return ['code' => (string) $cu['code'], 'name' => (string) $cu['name'], 'address' => (string) ($cu['address'] ?? '')];
            }
        }
        return ['code' => '', 'name' => '#' . $cid, 'address' => ''];
    }

    private static function versionOf(array $v): array
    {
        return ['outcome' => $v['outcome'] ?? null, 'weights' => ($v['weights'] ?? null) ?: [], 'tickets' => ($v['tickets'] ?? null) ?: [],
            'photos' => ($v['photos'] ?? null) ?: [], 'signature' => $v['signature'] ?? null, 'reason' => $v['reason'] ?? null,
            'note' => (string) ($v['note'] ?? ''), 'why' => $v['why'] ?? null];
    }

    /**
     * The next version of a visit (R30 step 2/3): rev + 1, the previous version appended to history,
     * op_id recorded in ops (the last 20), flags accumulated. $meta: by, driver_id, customer, captured_at,
     * received_at, op_id (null for server-made writes such as close-out), flags.
     */
    public static function build(?array $prev, int $cid, array $values, array $meta): array
    {
        $history = ($prev['history'] ?? null) ?: [];
        if ($prev !== null) {
            $history[] = ['rev' => (int) ($prev['rev'] ?? 0), 'at' => $prev['received_at'] ?? null, 'by' => $prev['by'] ?? null,
                'op_id' => $prev['op_id'] ?? null] + self::versionOf($prev) + ['driver_id' => $prev['driver_id'] ?? null, 'rejected' => false];
        }
        $ops = ($prev['ops'] ?? null) ?: [];
        if ($meta['op_id'] !== null) {
            $ops = array_slice(array_merge($ops, [['op_id' => $meta['op_id'], 'result' => 'applied']]), -self::MAX_OPS);
        }
        return ['customer_id' => $cid] + self::versionOf($values) + [
            'driver_id' => $meta['driver_id'],
            'by' => $meta['by'],
            'customer' => $meta['customer'],
            'captured_at' => $meta['captured_at'],
            'received_at' => $meta['received_at'],
            'rev' => (int) ($prev['rev'] ?? 0) + 1,
            'flags' => array_values(array_unique(array_merge(($prev['flags'] ?? null) ?: [], $meta['flags']))),
            'op_id' => $meta['op_id'],
            'ops' => $ops,
            'history' => $history,
        ];
    }

    /** API shape of a visit; drivers get it without ops and history. Empty maps encode as {}. */
    public static function publicVisit(?array $v, bool $full): ?array
    {
        if ($v === null) {
            return null;
        }
        $obj = static function (array $x): array {
            $x['weights'] = (object) (($x['weights'] ?? null) ?: []);
            $x['tickets'] = (object) (($x['tickets'] ?? null) ?: []);
            $x['photos'] = array_values(($x['photos'] ?? null) ?: []);
            return $x;
        };
        $v = $obj($v);
        $v['flags'] = array_values(($v['flags'] ?? null) ?: []);
        if (!$full) {
            unset($v['ops'], $v['history']);
            return $v;
        }
        $v['ops'] = array_values(($v['ops'] ?? null) ?: []);
        $v['history'] = array_map($obj, array_values(($v['history'] ?? null) ?: []));
        return $v;
    }
}
