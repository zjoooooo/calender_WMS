<?php
// Routes (§10.5): R5 code/colour, R6 types and day classes, R10 stop lists, R11 past lock (op_date),
// R12 save scope, R14 change schedule, R15 copy to date, skip/restore/reset/delete, R20 revisions.
// Basic fixture: today Wed 2026-11-11; N1 (id 5, Mon/Wed/Fri, rev 4) has a run today held by Ali.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = []) => TestEnv::make($given['now'] ?? $now, ['fixture' => 'basic'] + $given);
    $post = static fn (TestEnv $e, array $body) => $e->call('POST', '/api/routes', $body, 'mei');
    $route = static function (TestEnv $e, int $id): ?array {
        foreach ($e->doc('plan')['routes'] as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        return null;
    };
    $occ = static function (TestEnv $e, string $date, int $routeId): ?array {
        $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=' . $date, null, 'mei'));
        foreach ($cal['routes'] as $o) {
            if ($o['route_id'] === $routeId && $o['date'] === $date) {
                return $o;
            }
        }
        return null;
    };
    $stops = static fn (int ...$ids) => array_map(static fn ($id) => ['customer_id' => $id, 'note' => ''], $ids);

    return [
        'R6 regular: Monday to Saturday only, de-duplicated and sorted' => function () use ($env, $post, $stops) {
            $e = $env();
            $base = ['type' => 'regular', 'code' => 'W1', 'name' => 'West 1', 'start' => '2026-11-16', 'stops' => $stops(12)];
            T::err($post($e, $base + ['days' => [1, 7]]), 422, 'WEEKDAY_NOT_ALLOWED');
            T::err($post($e, $base + ['days' => []]), 422, 'WEEKDAY_NOT_ALLOWED');
            T::err($post($e, $base + ['days' => [2], 'sun' => true]), 422, 'WEEKDAY_NOT_ALLOWED');
            T::err($post($e, $base + ['days' => ['1']]), 422, 'WEEKDAY_NOT_ALLOWED');
            $r = T::ok($post($e, $base + ['days' => [5, 3, 3], 'note' => 'n']), 201);
            T::subset(['id' => 45, 'code' => 'W1', 'type' => 'regular', 'recurring' => true, 'days' => [3, 5], 'start' => '2026-11-16',
                'end' => null, 'date' => null, 'sun' => null, 'rev' => 1, 'stops' => [['customer_id' => 12, 'note' => '']]], $r);
            T::eq(['id' => 45, 'code' => 'W1', 'color' => 3, 'type' => 'regular', 'name' => 'West 1', 'note' => 'n', 'rev' => 1,
                'start' => '2026-11-16', 'end' => null, 'days' => [3, 5], 'stops' => [['customer_id' => 12, 'note' => '']]],
                $e->doc('plan')['routes'][6], 'stored shape (§4.4)');
            T::eq(45, $e->doc('plan')['seq']['route']);
            T::err($post($e, ['type' => 'regular', 'code' => 'W2', 'name' => 'x', 'date' => '2026-11-12', 'stops' => []]), 422, 'DAY_CLASS_VIOLATION');
        },
        'R6 special: every Sunday and/or PH; a one-off only on a rest day' => function () use ($env, $post, $stops) {
            $e = $env();
            T::err($post($e, ['type' => 'special', 'code' => 'S9', 'name' => 'x', 'start' => '2026-11-15', 'sun' => false, 'ph' => false, 'stops' => []]),
                422, 'DAY_CLASS_VIOLATION');
            T::err($post($e, ['type' => 'special', 'code' => 'S9', 'name' => 'x', 'start' => '2026-11-15', 'days' => [1], 'ph' => true, 'stops' => []]),
                422, 'DAY_CLASS_VIOLATION');
            T::err($post($e, ['type' => 'special', 'code' => 'S9', 'name' => 'x', 'date' => '2026-11-16', 'stops' => $stops(21)]), 422, 'DAY_CLASS_VIOLATION');
            T::subset(['type' => 'special', 'sun' => false, 'ph' => true, 'days' => null],
                T::ok($post($e, ['type' => 'special', 'code' => 'S9', 'name' => 'PH only', 'start' => '2026-11-15', 'ph' => true, 'stops' => $stops(21)]), 201));
            T::subset(['type' => 'special', 'recurring' => false, 'date' => '2026-11-22', 'copied_from' => null],
                T::ok($post($e, ['type' => 'special', 'code' => 'S8', 'name' => 'Sunday once', 'date' => '2026-11-22', 'stops' => $stops(21)]), 201));
            T::ok($post($e, ['type' => 'special', 'code' => 'S7', 'name' => 'Xmas', 'date' => '2026-12-25', 'stops' => $stops(21)]), 201);
        },
        'R6 adhoc: a one-off on a work day, never on a Sunday or a PH' => function () use ($env, $post, $stops) {
            $e = $env();
            $a = ['type' => 'adhoc', 'code' => 'A5', 'name' => 'Urgent', 'stops' => $stops(12)];
            T::err($post($e, $a + ['date' => '2026-11-15']), 422, 'DAY_CLASS_VIOLATION');
            T::err($post($e, $a + ['date' => '2026-12-25']), 422, 'DAY_CLASS_VIOLATION');
            T::err($post($e, $a + ['start' => '2026-11-16', 'days' => [1]]), 422, 'DAY_CLASS_VIOLATION');
            T::err($post($e, $a + ['date' => '2026-11-13', 'days' => [1]]), 422, 'DAY_CLASS_VIOLATION');
            T::subset(['type' => 'adhoc', 'date' => '2026-11-13'], T::ok($post($e, $a + ['date' => '2026-11-13']), 201));
            // a one-off date change is re-checked by R6
            T::err($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'date' => '2026-11-15'], 'mei'), 422, 'DAY_CLASS_VIOLATION');
            T::subset(['date' => '2026-11-14', 'rev' => 2], T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'date' => '2026-11-14'], 'mei')));
        },
        'R10 stop lists: only active routable customers, once each; an empty list warns' => function () use ($env, $post, $stops) {
            $e = $env();
            $a = ['type' => 'adhoc', 'code' => 'A5', 'name' => 'x', 'date' => '2026-11-13'];
            T::err($post($e, $a + ['stops' => $stops(50)]), 422, 'CUSTOMER_NOT_ROUTABLE'); // OTC-only customer
            T::err($post($e, $a + ['stops' => $stops(60)]), 422, 'CUSTOMER_INACTIVE');
            T::err($post($e, $a + ['stops' => $stops(12, 40, 12)]), 422, 'DUPLICATE_STOP');
            T::subset(['field' => 'stops.0.customer_id'], T::err($post($e, $a + ['stops' => $stops(999)]), 422, 'VALIDATION'));
            T::err($post($e, $a + ['stops' => [['customer_id' => 12, 'extra' => 1]]]), 422, 'VALIDATION');
            $res = $post($e, $a + ['stops' => []]);
            T::ok($res, 201);
            T::subset([['code' => 'EMPTY_ROUTE']], $res['json']['warnings']);
            T::eq([], $post($e, ['code' => 'A6'] + $a + ['stops' => $stops(12)])['json']['warnings']);
        },
        'R5 code: upper-cased, CODE_IN_USE only for overlapping periods, adhoc codes reused on other dates' => function () use ($env, $post, $stops) {
            $e = $env();
            $reg = ['type' => 'regular', 'name' => 'x', 'start' => '2026-11-16', 'days' => [2], 'stops' => $stops(12)];
            $err = T::err($post($e, $reg + ['code' => 'n1']), 422, 'CODE_IN_USE');
            T::subset(['field' => 'code', 'details' => ['route' => ['id' => 5, 'code' => 'N1']]], $err);
            T::subset(['code' => 'E9'], T::ok($post($e, $reg + ['code' => ' e9 ']), 201), 'E9 ended on 1 Nov: no overlap');
            T::err($post($e, $reg + ['code' => 'N_1']), 422, 'VALIDATION');
            T::err($post($e, $reg + ['code' => 'TOOLONGCODE']), 422, 'VALIDATION');
            $adhoc = ['type' => 'adhoc', 'name' => 'x', 'stops' => $stops(12)];
            T::err($post($e, $adhoc + ['code' => 'A1', 'date' => '2026-11-12']), 422, 'CODE_IN_USE');
            T::ok($post($e, $adhoc + ['code' => 'A1', 'date' => '2026-11-13']), 201);
            // renaming a code into an overlapping one is refused too
            T::err($e->call('PATCH', '/api/routes/7', ['rev' => 1, 'code' => 'N1'], 'mei'), 422, 'CODE_IN_USE');
            // a code free before a route starts: S1 starts 15 Nov
            T::ok($post($e, $adhoc + ['code' => 'S1', 'date' => '2026-11-13']), 201);
            T::err($post($e, ['type' => 'special', 'code' => 'S1', 'name' => 'x', 'date' => '2026-11-22', 'stops' => []]), 422, 'CODE_IN_USE');
        },
        'R5 colour: the least-used colour among live routes, ties to the lowest; editable' => function () use ($env, $post, $stops) {
            $e = $env(); // live colours: N1 1, S1 5, A1 2, N1-25 1, S2 4 (E9's 3 has ended)
            $a = ['type' => 'adhoc', 'name' => 'x', 'date' => '2026-11-13', 'stops' => $stops(12)];
            T::eq(3, T::ok($post($e, $a + ['code' => 'A7']), 201)['color']);
            T::eq(6, T::ok($post($e, $a + ['code' => 'A8']), 201)['color']);
            T::eq(1, T::ok($post($e, $a + ['code' => 'A9', 'color' => 1]), 201)['color'], 'repeats allowed');
            T::err($post($e, $a + ['code' => 'A10', 'color' => 11]), 422, 'VALIDATION');
            T::eq(9, T::ok($e->call('PATCH', '/api/routes/7', ['rev' => 1, 'color' => 9], 'mei'))['color']);
        },
        'R6/R20: type is immutable; the rev must match; unknown fields refused' => function () use ($env) {
            $e = $env();
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'type' => 'special'], 'mei'), 422, 'TYPE_IMMUTABLE');
            T::subset(['details' => ['current' => 4]], T::err($e->call('PATCH', '/api/routes/5', ['rev' => 3, 'name' => 'x'], 'mei'), 409, 'STALE_REVISION'));
            T::err($e->call('PATCH', '/api/routes/5', ['name' => 'x'], 'mei'), 422, 'VALIDATION');
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'colour' => 2], 'mei'), 422, 'VALIDATION');
            T::err($e->call('PATCH', '/api/routes/99', ['rev' => 1], 'mei'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/routes', null, 'ali'), 403, 'FORBIDDEN');
            $r = T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'type' => 'regular', 'name' => 'North 1 · Woodlands'], 'mei'));
            T::subset(['rev' => 5, 'name' => 'North 1 · Woodlands'], $r);
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'y'], 'mei'), 409, 'STALE_REVISION');
        },
        'R11: an unchanged past start is accepted; a changed one must be >= today; end >= today - 1' => function () use ($env, $noRuns) {
            $e = $env(['days' => $noRuns]);
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'Renamed', 'start' => '2026-11-02', 'end' => null], 'mei'));
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 5, 'start' => '2026-11-03'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 5, 'end' => '2026-11-09'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::subset(['end' => '2026-11-10', 'rev' => 6], T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 5, 'end' => '2026-11-10'], 'mei')),
                '"End route from today" = end yesterday');
            T::err($e->call('POST', '/api/routes', ['type' => 'regular', 'code' => 'W1', 'name' => 'x', 'start' => '2026-11-10', 'days' => [1], 'stops' => []], 'mei'),
                422, 'PAST_DATE_LOCKED');
            T::err($e->call('POST', '/api/routes', ['type' => 'adhoc', 'code' => 'A5', 'name' => 'x', 'date' => '2026-11-10', 'stops' => []], 'mei'),
                422, 'PAST_DATE_LOCKED');
            T::err($e->call('PATCH', '/api/routes/7', ['rev' => 1, 'end' => '2026-11-13'], 'mei'), 422, 'VALIDATION'); // end before start - 1
            T::ok($e->call('PATCH', '/api/routes/7', ['rev' => 1, 'end' => '2026-11-14'], 'mei'));
        },
        'R11 past lock uses the op_date: 03:30 still edits Wed, 04:00 locks it' => function () use ($env, $stops) {
            $e = $env(['now' => '2026-11-12T03:30:00+08:00']);
            $body = ['type' => 'adhoc', 'code' => 'A5', 'name' => 'night', 'date' => '2026-11-11', 'stops' => $stops(21)];
            T::ok($e->call('POST', '/api/routes', $body, 'mei'), 201);
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'note' => 'night shift'], 'mei'));
            $e->setNow('2026-11-12T04:00:00+08:00');
            T::err($e->call('POST', '/api/routes', ['code' => 'A6'] + $body, 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 5, 'scope' => 'this', 'note' => 'late'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::ok($e->call('POST', '/api/routes', ['code' => 'A6', 'date' => '2026-11-12'] + $body, 'mei'), 201);
        },
        'R12 only this date: override(D) stops and note; reset deletes it' => function () use ($env, $stops, $route, $occ) {
            $e = $env();
            $res = T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 4, 'scope' => 'this', 'stops' => $stops(40), 'note' => 'small truck'], 'mei'));
            T::subset(['route' => ['id' => 5, 'rev' => 5, 'stops' => [['customer_id' => 12], ['customer_id' => 40]]],
                'occurrence' => ['key' => 'r5@2026-11-13', 'edited' => true, 'note' => 'small truck', 'occurrence_note' => 'small truck',
                    'stops' => [['seq' => 1, 'customer_id' => 40]], 'run_status' => 'planned']], $res);
            T::subset(['route_overrides' => ['$contains' => [['route_id' => 5, 'date' => '2026-11-13', 'cancelled' => false,
                'stops' => [['customer_id' => 40, 'note' => '']], 'note' => 'small truck']]]], $e->doc('plan'));
            T::err($e->call('PUT', '/api/routes/5/dates/2026-11-12', ['rev' => 5, 'scope' => 'this', 'note' => 'x'], 'mei'), 422, 'NOT_AN_OCCURRENCE');
            T::err($e->call('PUT', '/api/routes/5/dates/2026-11-10', ['rev' => 5, 'scope' => 'this', 'note' => 'x'], 'mei'), 422, 'PAST_DATE_LOCKED');
            $r = T::ok($e->call('DELETE', '/api/routes/5/dates/2026-11-13?rev=5', null, 'mei'));
            T::subset(['route' => ['rev' => 6], 'occurrence' => ['edited' => false, 'stops' => ['$len' => 2]]], $r);
            T::eq('planned', $occ($e, '2026-11-13', 5)['run_status']);
            // an override equal to the template is removed after the write (R9: the "edited" badge never lies)
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 6, 'scope' => 'this',
                'stops' => [['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']]], 'mei'));
            T::eq(false, $occ($e, '2026-11-13', 5)['edited']);
            T::eq(7, $route($e, 5)['rev']);
        },
        'R12 this date and following: a template replace when D is the next date the route runs' => function () use ($env, $stops, $route, $noRuns) {
            $e = $env(['days' => $noRuns, 'plan' => ['route_overrides' => [
                ['route_id' => 5, 'date' => '2026-11-11', 'cancelled' => false, 'stops' => $stops(12), 'note' => ''],
                ['route_id' => 5, 'date' => '2026-11-18', 'cancelled' => false, 'stops' => $stops(12), 'note' => 'small truck']]]]);
            $res = T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'following', 'stops' => $stops(40, 21), 'note' => 'today only'], 'mei'));
            T::subset(['route' => ['id' => 5, 'rev' => 5, 'stops' => [['customer_id' => 40], ['customer_id' => 21]]],
                'occurrence' => ['edited' => true, 'note' => 'today only', 'stops' => [['customer_id' => 40], ['customer_id' => 21]]],
                'ended' => ['$absent' => true]], $res);
            T::eq([['route_id' => 5, 'date' => '2026-11-11', 'cancelled' => false, 'stops' => null, 'note' => 'today only'],
                ['route_id' => 5, 'date' => '2026-11-18', 'cancelled' => false, 'stops' => $stops(12), 'note' => 'small truck']],
                $e->doc('plan')['route_overrides'], 'override(D).stops cleared, note kept on D; later own lists unchanged');
            T::eq(6, count($e->doc('plan')['routes']), 'no split');
            T::eq([['customer_id' => 40, 'note' => ''], ['customer_id' => 21, 'note' => '']], $route($e, 5)['stops']);
        },
        'R12/R14 this date and following: a split from D keeps code and colour, moves overrides, re-points copies' => function () use ($env, $stops, $route, $occ) {
            $e = $env();
            $res = T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 4, 'scope' => 'following', 'stops' => $stops(40), 'note' => 'from Fri'], 'mei'));
            T::subset(['ended' => ['id' => 5, 'end' => '2026-11-12', 'rev' => 5],
                'route' => ['id' => 45, 'code' => 'N1', 'color' => 1, 'start' => '2026-11-13', 'end' => null, 'days' => [1, 3, 5], 'rev' => 1,
                    'stops' => [['customer_id' => 40]]],
                'occurrence' => ['route_id' => 45, 'note' => 'from Fri', 'stops' => [['customer_id' => 40]]]], $res);
            $plan = $e->doc('plan');
            T::subset(['route_overrides' => [
                ['route_id' => 45, 'date' => '2026-11-13', 'stops' => null, 'note' => 'from Fri'],
                ['route_id' => 45, 'date' => '2026-11-18', 'note' => 'small truck']]], $plan, 'overrides >= D moved; the past one purged (R9)');
            T::subset(['copied_from' => ['route_id' => 45, 'date' => '2026-12-25'], 'rev' => 2], $route($e, 42), 'R14 re-points copied_from');
            T::eq(5, $occ($e, '2026-11-11', 5)['route_id'], 'today still on the old route');
            T::eq('N1', $occ($e, '2026-11-16', 45)['code']);
            T::eq(null, $occ($e, '2026-11-16', 5));
            T::eq([['route_id' => 42, 'code' => 'N1-25', 'date' => '2026-12-25']], $occ($e, '2026-12-25', 45)['covered_by']);
        },
        'R14 change schedule from D' => function () use ($env, $route) {
            $e = $env();
            T::err($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 4, 'from' => '2026-11-11', 'days' => [2]], 'mei'), 422, 'VALIDATION');
            T::err($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 4, 'from' => '2026-11-10', 'days' => [2]], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 4, 'from' => '2026-11-23', 'days' => [7]], 'mei'), 422, 'WEEKDAY_NOT_ALLOWED');
            T::err($e->call('POST', '/api/routes/41/change-schedule', ['rev' => 1, 'from' => '2026-11-23'], 'mei'), 422, 'VALIDATION');
            $r = T::ok($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 4, 'from' => '2026-11-23', 'days' => [4, 2]], 'mei'));
            T::subset(['ended' => ['id' => 5, 'end' => '2026-11-22', 'days' => [1, 3, 5]],
                'created' => ['id' => 45, 'code' => 'N1', 'start' => '2026-11-23', 'days' => [2, 4], 'stops' => [['customer_id' => 12], ['customer_id' => 40]]]], $r);
            T::subset(['route_overrides' => [['route_id' => 5, 'date' => '2026-11-18']]], $e->doc('plan'), 'override before D stays');
            T::eq(45, $route($e, 42)['copied_from']['route_id'], 'N1-25 (25 Dec) re-pointed');
            // the split route can be split again; special keeps sun/ph unless sent
            $s = T::ok($e->call('POST', '/api/routes/7/change-schedule', ['rev' => 1, 'from' => '2026-11-22', 'ph' => false], 'mei'));
            T::subset(['created' => ['sun' => true, 'ph' => false, 'start' => '2026-11-22']], $s);
            T::err($e->call('POST', '/api/routes/7/change-schedule', ['rev' => 2, 'from' => '2026-11-15'], 'mei'), 422, 'VALIDATION'); // from <= start
        },
        'R15 copy: a PH-paused regular moved to a work day keeps type regular' => function () use ($env, $occ) {
            $e = $env();
            $r = T::ok($e->call('POST', '/api/routes/5/dates/2026-12-25/copy', ['rev' => 4, 'to' => '2026-12-26'], 'mei'), 201);
            T::subset(['created' => ['id' => 45, 'type' => 'regular', 'recurring' => false, 'code' => 'N1-26', 'color' => 1, 'date' => '2026-12-26',
                'name' => 'North 1 (from Fri 25 Dec)', 'copied_from' => ['route_id' => 5, 'date' => '2026-12-25'],
                'stops' => [['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']]]], $r);
            $paused = $occ($e, '2026-12-25', 5);
            T::subset(['status' => 'holiday_skipped', 'run_status' => null,
                'covered_by' => [['route_id' => 42, 'code' => 'N1-25', 'date' => '2026-12-25'], ['route_id' => 45, 'code' => 'N1-26', 'date' => '2026-12-26']]], $paused);
            T::subset(['type' => 'regular', 'status' => 'scheduled', 'run_status' => 'planned'], $occ($e, '2026-12-26', 45));
            // "Run on PH": same date -> a special one-off; N1-25 is taken, so the suggestion adds a letter
            $s = T::ok($e->call('POST', '/api/routes/5/dates/2026-12-25/copy', ['rev' => 4, 'to' => '2026-12-25'], 'mei'), 201);
            T::subset(['created' => ['type' => 'special', 'code' => 'N1-25B', 'date' => '2026-12-25']], $s);
            // skip_source is refused on a paused (not runnable) date
            T::err($e->call('POST', '/api/routes/5/dates/2026-12-25/copy', ['rev' => 4, 'to' => '2026-12-28', 'skip_source' => true], 'mei'), 422, 'VALIDATION');
            T::err($e->call('POST', '/api/routes/5/dates/2026-12-25/copy', ['rev' => 4, 'to' => '2026-11-10'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('POST', '/api/routes/5/dates/2026-12-24/copy', ['rev' => 4, 'to' => '2026-12-28'], 'mei'), 422, 'NOT_AN_OCCURRENCE');
            T::err($e->call('POST', '/api/routes/5/dates/2026-12-25/copy', ['rev' => 4, 'to' => '2026-12-26', 'code' => 'N1-26'], 'mei'), 422, 'CODE_IN_USE');
        },
        'R15 copy: adhoc stays adhoc on a work day, any source becomes special on a rest day; skip_source' => function () use ($env, $occ) {
            $e = $env();
            T::subset(['created' => ['type' => 'adhoc', 'code' => 'A1-13', 'name' => 'Adhoc 12 Nov (from Thu 12 Nov)']],
                T::ok($e->call('POST', '/api/routes/41/dates/2026-11-12/copy', ['rev' => 1, 'to' => '2026-11-13'], 'mei'), 201));
            T::subset(['created' => ['type' => 'special', 'code' => 'A1-15']],
                T::ok($e->call('POST', '/api/routes/41/dates/2026-11-12/copy', ['rev' => 1, 'to' => '2026-11-15'], 'mei'), 201));
            T::err($e->call('POST', '/api/routes/41/dates/2026-11-12/copy', ['rev' => 1, 'to' => '2026-11-16', 'skip_source' => true], 'mei'), 422, 'VALIDATION');
            $r = T::ok($e->call('POST', '/api/routes/5/dates/2026-11-13/copy', ['rev' => 4, 'to' => '2026-11-14', 'code' => 'n1-sat', 'name' => 'Sat run', 'skip_source' => true], 'mei'), 201);
            T::subset(['created' => ['code' => 'N1-SAT', 'name' => 'Sat run', 'type' => 'regular']], $r);
            T::subset(['status' => 'cancelled', 'edited' => true, 'covered_by' => [['code' => 'N1-SAT', 'date' => '2026-11-14']]], $occ($e, '2026-11-13', 5));
            T::err($e->call('POST', '/api/routes/5/dates/2026-11-13/copy', ['rev' => 4, 'to' => '2026-11-16'], 'mei'), 409, 'STALE_REVISION');
            // restore the skipped date
            T::subset(['occurrence' => ['status' => 'scheduled']],
                T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 5, 'scope' => 'this', 'cancelled' => false], 'mei')));
            T::eq([], array_values(array_filter($e->doc('plan')['route_overrides'], static fn ($o) => $o['date'] === '2026-11-13')),
                'a restored date with no note leaves no override');
        },
        'R15 copy from a past date reads its frozen plan, also after the route was deleted' => function () use ($env, $noRuns) {
            $e = $env(['days' => $noRuns, 'plan' => ['frozen_through' => '2026-11-08']]);
            T::ok($e->call('GET', '/api/meta', null, 'mei')); // freezes 9 and 10 Nov
            T::eq(204, $e->call('DELETE', '/api/routes/5?rev=4', null, 'mei')['status']);
            $r = T::ok($e->call('POST', '/api/routes/5/dates/2026-11-09/copy', ['to' => '2026-11-12'], 'mei'), 201);
            T::subset(['created' => ['type' => 'regular', 'code' => 'N1-12', 'name' => 'North 1 (from Mon 9 Nov)',
                'copied_from' => ['route_id' => 5, 'date' => '2026-11-09'], 'stops' => ['$len' => 2]]], $r);
            T::err($e->call('POST', '/api/routes/5/dates/2026-11-10/copy', ['to' => '2026-11-12'], 'mei'), 404, 'NOT_FOUND');
            T::err($e->call('POST', '/api/routes/5/dates/2026-11-09/copy', ['to' => '2026-11-16', 'skip_source' => true], 'mei'), 422, 'VALIDATION');
        },
        'suggest-code: A<n> / S<n> free on the date, copy rule, day class and resulting type' => function () use ($env) {
            $e = $env();
            $q = static fn (string $qs) => T::ok($e->call('GET', '/api/routes/suggest-code?' . $qs, null, 'mei'));
            T::eq(['code' => 'A2', 'class' => 'work', 'holiday' => null, 'type' => 'adhoc'], $q('type=adhoc&date=2026-11-12'));
            T::eq(['code' => 'A1', 'class' => 'work', 'holiday' => null, 'type' => 'adhoc'], $q('type=adhoc&date=2026-11-13'));
            T::eq(['code' => 'S2', 'class' => 'rest', 'holiday' => null, 'type' => 'special'], $q('type=adhoc&date=2026-11-15'), 'S1 runs on Sundays');
            T::eq(['code' => 'S3', 'class' => 'rest', 'holiday' => 'Test Sunday PH', 'type' => 'special'], $q('type=special&date=2026-11-29'));
            T::eq(['code' => 'N1-25B', 'class' => 'rest', 'holiday' => 'Christmas Day', 'type' => 'special'], $q('type=copy&date=2026-12-25&route_id=5'));
            T::eq(['code' => 'N1-26', 'class' => 'work', 'holiday' => null, 'type' => 'regular'], $q('type=copy&date=2026-12-26&route_id=5'));
            T::eq('adhoc', $q('type=copy&date=2026-11-13&route_id=41')['type']);
            T::err($e->call('GET', '/api/routes/suggest-code?type=copy&date=2026-11-13', null, 'mei'), 422, 'VALIDATION');
            T::err($e->call('GET', '/api/routes/suggest-code?type=x&date=2026-11-13', null, 'mei'), 422, 'VALIDATION');
        },
        'delete: a one-off and a recurring route with its overrides (past days stay frozen)' => function () use ($env, $route, $noRuns) {
            $e = $env(['days' => $noRuns]);
            T::err($e->call('DELETE', '/api/routes/41', null, 'mei'), 422, 'VALIDATION');
            T::err($e->call('DELETE', '/api/routes/41?rev=2', null, 'mei'), 409, 'STALE_REVISION');
            T::eq(204, $e->call('DELETE', '/api/routes/41?rev=1', null, 'mei')['status']);
            T::eq(null, $route($e, 41));
            T::eq(204, $e->call('DELETE', '/api/routes/5?rev=4', null, 'mei')['status']);
            T::eq([], $e->doc('plan')['route_overrides']);
            T::err($e->call('GET', '/api/routes/5', null, 'mei'), 404, 'NOT_FOUND');
        },
        'split route (OFF-3/OFF-4): "from today" edits and Delete route reach every segment that runs today or later' => function () use ($env, $stops, $route, $occ, $noRuns) {
            // an ended N1 segment (id 3) runs up to 1 Nov, the day before N1 (id 5) starts
            $fx = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true);
            $routes = $fx['plan']['routes'];
            array_unshift($routes, ['id' => 3, 'code' => 'N1', 'color' => 1, 'type' => 'regular', 'name' => 'North 1', 'note' => '', 'rev' => 1,
                'start' => '2026-10-05', 'end' => '2026-11-01', 'days' => [1, 3, 5], 'stops' => $stops(12)]);
            $e = $env(['days' => $noRuns, 'plan' => ['routes' => $routes]]);
            // two "following" saves and a planned schedule change: 5 (.. 12 Nov), 45 (13-19 Nov), 46 (20-29 Nov), 47 (30 Nov .., Mon/Wed)
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 4, 'scope' => 'following', 'stops' => $stops(40)], 'mei'));
            T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-20', ['rev' => 1, 'scope' => 'following', 'stops' => $stops(40, 12)], 'mei'));
            T::ok($e->call('POST', '/api/routes/46/change-schedule', ['rev' => 1, 'from' => '2026-11-30', 'days' => [1, 3]], 'mei'));
            T::subset(['end' => '2026-11-19', 'rev' => 2], $route($e, 45));
            T::subset(['start' => '2026-11-20', 'end' => '2026-11-29', 'rev' => 2], $route($e, 46));

            // OFF-4: Edit route on 25 Nov (segment 46), "from today": a new name and Saturday added
            $r = T::ok($e->call('PATCH', '/api/routes/46', ['rev' => 2, 'name' => 'North 1 renamed', 'days' => [1, 3, 5, 6]], 'mei'));
            T::subset(['id' => 46, 'name' => 'North 1 renamed', 'days' => [1, 3, 5, 6], 'start' => '2026-11-20', 'rev' => 3], $r);
            T::subset(['name' => 'North 1 renamed', 'days' => [1, 3, 5, 6], 'end' => '2026-11-12', 'rev' => 6], $route($e, 5));
            T::subset(['name' => 'North 1 renamed', 'days' => [1, 3, 5, 6], 'stops' => [['customer_id' => 40]], 'rev' => 3], $route($e, 45), 'stops stay per segment');
            T::subset(['name' => 'North 1 renamed', 'days' => [1, 3, 6], 'start' => '2026-11-30', 'rev' => 2], $route($e, 47),
                'the planned Mon/Wed schedule is kept and gains Saturday');
            T::subset(['name' => 'North 1', 'days' => [1, 3, 5], 'rev' => 1], $route($e, 3), 'an ended segment is history');
            T::eq('North 1 renamed', $occ($e, '2026-11-13', 45)['name']);
            T::subset(['name' => 'North 1 renamed', 'status' => 'scheduled'], $occ($e, '2026-11-14', 45), 'Sat 14 Nov now runs');
            T::subset(['name' => 'North 1 renamed', 'status' => 'scheduled'], $occ($e, '2026-11-21', 46));
            T::subset(['name' => 'North 1 renamed', 'status' => 'scheduled'], $occ($e, '2026-12-05', 47));
            T::eq(null, $occ($e, '2026-12-04', 47), 'Fri is still not in the planned schedule');
            // an edit of the ended segment stays on it
            T::ok($e->call('PATCH', '/api/routes/3', ['rev' => 1, 'note' => 'archive'], 'mei'));
            T::eq('', $route($e, 46)['note']);
            // a code change is checked on every segment, all or nothing: A1 (12 Nov) overlaps segment 5 only
            T::subset(['details' => ['route' => ['id' => 41]]], T::err($e->call('PATCH', '/api/routes/45', ['rev' => 3, 'code' => 'A1'], 'mei'), 422, 'CODE_IN_USE'));
            T::eq(['N1', 'N1', 'N1', 'N1'], [$route($e, 5)['code'], $route($e, 45)['code'], $route($e, 46)['code'], $route($e, 47)['code']]);
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 3, 'code' => 'nx', 'color' => 7], 'mei'));
            T::eq(['NX', 'NX', 'NX', 'NX', 'N1'], [$route($e, 5)['code'], $route($e, 45)['code'], $route($e, 46)['code'], $route($e, 47)['code'], $route($e, 3)['code']]);
            T::eq([7, 7, 7], [$route($e, 5)['color'], $route($e, 46)['color'], $route($e, 47)['color']]);

            // OFF-3: Delete route on 10 Dec (segment 47) deletes every segment that runs today or later, with their overrides
            T::ok($e->call('PUT', '/api/routes/46/dates/2026-11-23', ['rev' => 4, 'scope' => 'this', 'note' => 'small truck'], 'mei'));
            T::eq(204, $e->call('DELETE', '/api/routes/47?rev=3', null, 'mei')['status']);
            T::eq([3, 7, 8, 41, 42, 44], array_column($e->doc('plan')['routes'], 'id'), 'the ended segment 3 stays');
            T::eq([], $e->doc('plan')['route_overrides']);
            foreach (['2026-11-11' => 5, '2026-11-13' => 45, '2026-11-23' => 46, '2026-12-02' => 47] as $d => $id) {
                T::eq(null, $occ($e, $d, $id), "no N1 on $d");
            }
            // deleting an ended segment deletes only that segment
            T::ok($e->call('POST', '/api/routes', ['type' => 'regular', 'code' => 'N1', 'name' => 'North 1 again', 'start' => '2026-11-16', 'days' => [1], 'stops' => []], 'mei'), 201);
            T::eq(204, $e->call('DELETE', '/api/routes/3?rev=2', null, 'mei')['status']);
            T::eq('North 1 again', $route($e, 48)['name']);
        },
        'R11/R13 (API-2): a one-off route dated before today is frozen: PATCH and DELETE return PAST_DATE_LOCKED' => function () use ($env, $route, $stops) {
            $e = $env(['now' => '2026-11-13T03:30:00+08:00']); // op_date is still Thu 12 Nov: A1 (id 41, 12 Nov) can be edited
            T::subset(['note' => 'night shift', 'rev' => 2], T::ok($e->call('PATCH', '/api/routes/41', ['rev' => 1, 'note' => 'night shift'], 'mei')));
            $e->setNow('2026-11-13T04:00:00+08:00'); // 12 Nov has ended and is frozen
            $err = T::err($e->call('PATCH', '/api/routes/41', ['rev' => 2, 'name' => 'changed after the day', 'stops' => $stops(40)], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::subset(['field' => 'date', 'details' => ['date' => '2026-11-12', 'today' => '2026-11-13']], $err);
            T::err($e->call('PATCH', '/api/routes/41', ['rev' => 2, 'date' => '2026-11-16'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('DELETE', '/api/routes/41?rev=2', null, 'mei'), 422, 'PAST_DATE_LOCKED');
            T::subset(['name' => 'Adhoc 12 Nov', 'note' => 'night shift', 'rev' => 2, 'stops' => [['customer_id' => 12]]], $route($e, 41));
            T::subset(['id' => 41, 'name' => 'Adhoc 12 Nov'], T::ok($e->call('GET', '/api/routes/41', null, 'mei')));
            // one-offs dated today or later are still edited and deleted as before
            T::ok($e->call('PATCH', '/api/routes/44', ['rev' => 1, 'name' => 'PH Sunday'], 'mei'));
            T::eq(204, $e->call('DELETE', '/api/routes/44?rev=2', null, 'mei')['status']);
        },
        'GET /api/routes (list) and /api/routes/{id}' => function () use ($env) {
            $e = $env();
            $list = T::ok($e->call('GET', '/api/routes', null, 'mei'));
            T::eq(['A1', 'N1', 'N1-25', 'S1', 'S2'], array_column($list, 'code'), 'ended E9 hidden, natural order');
            T::subset(['id' => 5, 'stop_count' => 2, 'next_date' => '2026-11-11', 'today_status' => 'active', 'ended' => false,
                'days' => [1, 3, 5], 'rev' => 4, 'stops' => ['$absent' => true]], $list[1]);
            T::subset(['code' => 'S1', 'next_date' => '2026-11-15', 'today_status' => null], $list[3]);
            T::eq(6, count(T::ok($e->call('GET', '/api/routes?ended=1', null, 'mei'))));
            $one = T::ok($e->call('GET', '/api/routes/5', null, 'mei'));
            T::subset(['id' => 5, 'code' => 'N1', 'next_date' => '2026-11-11',
                'overrides' => [['route_id' => 5, 'date' => '2026-11-18', 'note' => 'small truck', 'stops' => [['customer_id' => 12]]]]], $one);
        },
    ];
})();
