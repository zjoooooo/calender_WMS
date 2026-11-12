<?php
// Free submissions of the non-routable waste types (OTC, COMPACTOR, EROSE …): nothing is planned for
// them. A driver submits one at any time: waste type -> customer registered with it -> weight (photos,
// signature, weighbridge ticket and truck plate as for a route stop). No office set-up and no claim.
//   GET /api/driver/customers                  (driver) the customers a submission can be made for
//   GET /api/driver/submissions[?date=]        (driver) my submissions of a day (default today)
//   PUT /api/driver/submissions/{date}/{id}    (driver) create, change or delete (outcome = null) my submission
//   GET /api/submissions?date=                 (office) every submission of a day, with history
//
// A submission lives in days/<date>.json under submissions[id]. {date} is the operational date the phone
// made it on and {id} a UUID the phone generated, so a resend can never make a second record; op_id makes a
// retry a replay, as for visits (R30). The record has the shape of a visit (Visits::values / build), plus
// id, date, waste_type and vehicle_no. A deleted submission keeps its record with outcome = null.
// The office only reads them in this version. They count in the calendar's day totals (Calendar::get).
final class Submissions
{
    /** The live (not deleted) submissions of a day doc, keyed by id. @return array<string,array> */
    public static function of(?array $dayDoc): array
    {
        $out = [];
        foreach (($dayDoc['submissions'] ?? null) ?: [] as $id => $s) {
            if (is_array($s) && ($s['outcome'] ?? null) === 'collected') {
                $out[(string) $id] = $s;
            }
        }
        return $out;
    }

    /** Sorted by the time the server received them, then by id. */
    private static function sorted(array $subs): array
    {
        $subs = array_values($subs);
        usort($subs, static fn ($a, $b) => [(string) ($a['received_at'] ?? ''), (string) $a['id']] <=> [(string) ($b['received_at'] ?? ''), (string) $b['id']]);
        return $subs;
    }

    /** GET /api/driver/customers -> [{id, code, name, address, waste_types}] (only the active non-routable types). */
    public static function driverCustomers(Ctx $c): array
    {
        $plan = $c->plan();
        $free = [];
        foreach ($plan['waste_types'] ?? [] as $t) {
            if (empty($t['routable']) && !empty($t['active'])) {
                $free[] = $t['code'];
            }
        }
        $out = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $types = array_values(array_intersect($free, $cu['waste_types'] ?? []));
            if (!empty($cu['active']) && $types !== []) {
                $out[] = ['id' => (int) $cu['id'], 'code' => (string) $cu['code'], 'name' => (string) $cu['name'],
                    'address' => (string) ($cu['address'] ?? ''), 'waste_types' => $types];
            }
        }
        usort($out, static fn ($a, $b) => [strtolower($a['name']), $a['id']] <=> [strtolower($b['name']), $b['id']]);
        return $out;
    }

    /** GET /api/driver/submissions[?date=] -> {today, date, submissions: mine, not deleted}. */
    public static function driverList(Ctx $c): array
    {
        $date = $c->query('date', '') ?: $c->today;
        V::date($date, 'date');
        $me = (int) $c->userId();
        $mine = array_filter(self::of($c->tx->get('day:' . $date)), static fn ($s) => (int) ($s['driver_id'] ?? 0) === $me);
        return ['today' => $c->today, 'date' => $date,
            'submissions' => array_map(static fn ($s) => Visits::publicVisit($s, false), self::sorted($mine))];
    }

    /** GET /api/submissions?date= -> {today, date, totals, submissions (with history and the driver's name)}. */
    public static function officeList(Ctx $c): array
    {
        $date = $c->query('date', '') ?: $c->today;
        V::date($date, 'date');
        $subs = self::of($c->tx->get('day:' . $date));
        $users = Runs::usersById($c);
        return ['today' => $c->today, 'date' => $date, 'totals' => (object) Calendar::totals($subs),
            'submissions' => array_map(static function (array $s) use ($users): array {
                $id = $s['driver_id'] ?? null;
                return Visits::publicVisit($s, true) + ['driver' => $id === null ? null : ($users[(int) $id]['name'] ?? ('#' . $id))];
            }, self::sorted($subs))];
    }

    /**
     * PUT /api/driver/submissions/{date}/{id}
     * {op_id, base_rev, waste_type, customer_id, vehicle_no, outcome: "collected"|null, weights, tickets, photos,
     *  signature, note, captured_at} -> 201 (new) | 200: {submission, replay}; warning LATE.
     */
    public static function driverWrite(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['op_id', 'base_rev', 'waste_type', 'customer_id', 'vehicle_no', 'outcome', 'weights', 'tickets', 'photos',
            'signature', 'reason', 'note', 'captured_at']);
        $date = $c->dateParam('date');
        $id = $c->param('id');
        if (!preg_match(Visits::OP_RE, $id)) {
            throw new ApiError('NOT_FOUND', 404, 'id', null, 'The submission id must be a UUID');
        }
        $opId = is_string($b['op_id'] ?? null) ? strtolower($b['op_id']) : '';
        if (!preg_match(Visits::OP_RE, $opId)) {
            throw new ApiError('VALIDATION', 422, 'op_id', null, "'op_id' must be a UUID");
        }
        V::int($b['base_rev'] ?? null, 'base_rev', 0);
        if (!array_key_exists('outcome', $b)) {
            throw new ApiError('VALIDATION', 422, 'outcome', null, "Missing field 'outcome'");
        }
        if ($b['outcome'] !== null && $b['outcome'] !== 'collected') {
            throw new ApiError('VALIDATION', 422, 'outcome', null, "'outcome' must be collected, or null to delete");
        }
        $me = (int) $c->userId();
        $plan = $c->plan();
        $doc = 'day:' . $date;
        $day = $c->tx->get($doc);
        $prev = $day['submissions'][$id] ?? null;
        if ($prev !== null && (int) ($prev['driver_id'] ?? 0) !== $me) {
            throw new ApiError('NOT_FOUND', 404, 'id'); // another driver's record
        }
        // A replay returns the recorded result and changes nothing (before every other rule, as in R30).
        foreach (($prev['ops'] ?? null) ?: [] as $op) {
            if (($op['op_id'] ?? null) === $opId) {
                return ['submission' => Visits::publicVisit($prev, false), 'replay' => true];
            }
        }
        $changing = $prev !== null && ($prev['outcome'] ?? null) !== null;
        if ($b['outcome'] === null && !$changing) {
            return ['submission' => Visits::publicVisit($prev, false), 'replay' => false]; // nothing to delete
        }

        $types = Usage::typesByCode($plan);
        if ($prev === null) {
            // A new submission: for today, or for a day the phone was offline on (up to submission_max_age_days back).
            $oldest = Dates::addDays($c->today, -(int) $c->config('submission_max_age_days'));
            if ($date > $c->today || $date < $oldest) {
                throw new ApiError('NOT_TODAY', 422, 'date', ['today' => $c->today, 'oldest' => $oldest]);
            }
            $code = V::str($b['waste_type'] ?? null, 'waste_type', 1, 10);
            $type = $types[$code] ?? null;
            if ($type !== null && !empty($type['routable'])) {
                throw new ApiError('TYPE_ROUTABLE', 422, 'waste_type', ['waste_type' => $code]);
            }
            if ($type === null || empty($type['active'])) {
                throw new ApiError('TYPE_NOT_ALLOWED', 422, 'waste_type', ['waste_type' => $code]);
            }
            $cid = V::id($b['customer_id'] ?? null, 'customer_id');
            $cu = Schedule::index($plan)['customers'][$cid] ?? null;
            if ($cu === null) {
                throw new ApiError('VALIDATION', 422, 'customer_id', ['customer_id' => $cid], 'Unknown customer');
            }
            if (empty($cu['active'])) {
                throw new ApiError('CUSTOMER_INACTIVE', 422, 'customer_id', ['customer_id' => $cid, 'name' => $cu['name']]);
            }
            if (!in_array($code, $cu['waste_types'] ?? [], true)) {
                throw new ApiError('CUSTOMER_LACKS_TYPE', 422, 'customer_id', ['customer_id' => $cid, 'name' => $cu['name'], 'waste_type' => $code]);
            }
        } else {
            // The waste type and the customer of a submission never change: delete it and submit again.
            $code = (string) $prev['waste_type'];
            $cid = (int) $prev['customer_id'];
            if ((array_key_exists('waste_type', $b) && $b['waste_type'] !== $code)
                || (array_key_exists('customer_id', $b) && $b['customer_id'] !== $cid)) {
                V::fail(array_key_exists('waste_type', $b) && $b['waste_type'] !== $code ? 'waste_type' : 'customer_id',
                    'The waste type and the customer of a submission cannot change: delete it and submit again');
            }
            // A change or a delete follows the edit window of a route stop (R28).
            $deadline = Clock::editDeadline($date, $c->rollover, (int) $c->config('driver_edit_grace_hours'));
            if ($changing && $c->now >= $deadline) {
                throw new ApiError('EDIT_WINDOW_CLOSED', 422, null, ['deadline' => Clock::iso($deadline)]);
            }
        }
        $values = Visits::values($c, $b, $types, [$code]) + ['why' => null];
        $vehicle = $values['outcome'] === null ? ($prev['vehicle_no'] ?? null) : Runs::plate($plan, $b['vehicle_no'] ?? null);
        $cap = Clock::parse($b['captured_at'] ?? null);
        // LATE: the write arrived after its operational day ended (an offline phone, or a late correction).
        $flags = $c->now >= Clock::dayEnd($date, $c->rollover) ? ['LATE'] : [];
        $rec = ['id' => $id, 'date' => $date, 'waste_type' => $code, 'vehicle_no' => $vehicle] + Visits::build($prev, $cid, $values, [
            'by' => $c->principal(), 'driver_id' => $me, 'customer' => $prev['customer'] ?? Visits::snapshot($plan, $cid),
            'captured_at' => $cap === null ? null : Clock::iso($cap), 'received_at' => $c->nowIso, 'op_id' => $opId, 'flags' => $flags,
        ]);
        $day['submissions'][$id] = $rec;
        $c->tx->put($doc, $day);
        if ($flags !== []) {
            $c->warn('LATE');
        }
        $out = ['submission' => Visits::publicVisit($rec, false), 'replay' => false];
        return $prev === null ? $c->created($out) : $out;
    }
}
