<?php
// GET /api/calendar (§5.9, §10.4) and the R13 day freeze: ranges, day class, holidays, can_create, ops,
// totals, order, customers map, missing_holiday_years, paused PH routes, covered_by, the run overlay
// (R22 statuses) and frozen past days. Basic fixture: today Wed 2026-11-11.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = [], ?string $at = null) => TestEnv::make($at ?? $now, ['fixture' => 'basic'] + $given);
    $cal = static fn (TestEnv $e, string $qs = 'view=week&anchor=2026-11-11') => T::ok($e->call('GET', '/api/calendar?' . $qs, null, 'mei'));
    $day = static function (array $cal, string $date): array {
        foreach ($cal['days'] as $d) {
            if ($d['date'] === $date) {
                return $d;
            }
        }
        T::fail("no day $date");
    };
    $on = static fn (array $cal, string $list, string $date) => array_values(array_filter($cal[$list], static fn ($o) => $o['date'] === $date));

    return [
        'week: Monday to Sunday with prev/next anchors, day class, holiday, past, can_create, ops' => function () use ($env, $cal, $day) {
            $c = $cal($env());
            T::subset(['view' => 'week', 'from' => '2026-11-09', 'to' => '2026-11-15', 'today' => '2026-11-11',
                'prev_anchor' => '2026-11-02', 'next_anchor' => '2026-11-16', 'missing_holiday_years' => [], 'days' => ['$len' => 7]], $c);
            T::subset(['date' => '2026-11-09', 'dow' => 1, 'class' => 'rest', 'holiday' => 'Deepavali (observed)', 'past' => true,
                'in_month' => true, 'can_create' => [], 'ops' => ['$any' => true]], $day($c, '2026-11-09'));
            T::subset(['date' => '2026-11-11', 'dow' => 3, 'class' => 'work', 'holiday' => null, 'past' => false,
                'can_create' => ['regular', 'adhoc', 'task'], 'totals' => ['REL' => 120.5], 'provisional' => true,
                'ops' => ['not_started' => 0, 'active' => 2, 'open' => 0, 'done' => 0, 'incomplete' => 0, 'no_record' => 0]], $day($c, '2026-11-11'));
            T::subset(['class' => 'work', 'can_create' => ['regular', 'adhoc', 'task'], 'ops' => ['$absent' => true], 'provisional' => false],
                $day($c, '2026-11-12'));
            T::subset(['dow' => 7, 'class' => 'rest', 'can_create' => ['special', 'special_once', 'task']], $day($c, '2026-11-15'));
            $raw = $env()->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei')['response']->body;
            T::true(str_contains($raw, '"date":"2026-11-12","dow":4,"class":"work","holiday":null,"past":false,"in_month":true,'
                . '"can_create":["regular","adhoc","task"],"totals":{}'), 'empty totals encode as an object');
            // anchor defaults to today; any day of the week gives the same range
            T::eq('2026-11-09', $cal($env(), 'view=week')['from']);
            T::eq('2026-11-16', $cal($env(), 'view=week&anchor=2026-11-22')['from']);
            T::err($env()->call('GET', '/api/calendar?view=year', null, 'mei'), 422, 'VALIDATION');
            T::err($env()->call('GET', '/api/calendar?anchor=2026-13-01', null, 'mei'), 422, 'VALIDATION');
            T::err($env()->call('GET', '/api/calendar', null, 'ali'), 403, 'FORBIDDEN');
        },
        'month: a 6 x 7 grid from the Monday before the 1st, in_month flags' => function () use ($env, $cal, $day) {
            $c = $cal($env(), 'view=month&anchor=2026-11-11');
            T::subset(['view' => 'month', 'from' => '2026-10-26', 'to' => '2026-12-06', 'prev_anchor' => '2026-10-01', 'next_anchor' => '2026-12-01',
                'days' => ['$len' => 42]], $c);
            T::eq(false, $day($c, '2026-10-31')['in_month']);
            T::eq(true, $day($c, '2026-11-30')['in_month']);
            T::eq(false, $day($c, '2026-12-01')['in_month']);
            $j = $cal($env(), 'view=month&anchor=2027-01-20');
            T::subset(['from' => '2026-12-28', 'prev_anchor' => '2026-12-01', 'next_anchor' => '2027-02-01'], $j);
            $d = $cal($env(), 'view=month&anchor=2026-12-05');
            T::subset(['prev_anchor' => '2026-11-01', 'next_anchor' => '2027-01-01'], $d);
        },
        'occurrences: routes and tasks with keys, stops, covered_by, the paused PH group last; customers map' => function () use ($env, $cal, $on) {
            $c = $cal($env(), 'view=week&anchor=2026-12-25');
            T::eq(['r42@2026-12-25', 'r7@2026-12-25', 'r5@2026-12-25'], array_column($on($c, 'routes', '2026-12-25'), 'key'));
            T::subset(['key' => 'r5@2026-12-25', 'status' => 'holiday_skipped', 'run_status' => null, 'run' => null, 'frozen' => false,
                'covered_by' => [['route_id' => 42, 'code' => 'N1-25', 'date' => '2026-12-25']]], $on($c, 'routes', '2026-12-25')[2]);
            T::subset(['key' => 'r42@2026-12-25', 'kind' => 'route', 'type' => 'special', 'recurring' => false, 'status' => 'scheduled',
                'run_status' => 'planned', 'copied_from' => ['route_id' => 5, 'date' => '2026-12-25'], 'rev' => 1, 'edited' => false,
                'stops' => [['seq' => 1, 'customer_id' => 12, 'note' => '3 bins', 'visit' => null], ['seq' => 2, 'customer_id' => 40]], 'off_plan' => []],
                $on($c, 'routes', '2026-12-25')[0]);
            T::subset([['key' => 't3@2026-12-25', 'kind' => 'task', 'waste_type' => 'COMPACTOR', 'customer_id' => 40, 'run_status' => 'planned', 'visit' => null]],
                $on($c, 'tasks', '2026-12-25'));
            T::subset(['12' => ['code' => 'C0012', 'name' => 'ABC Restaurant', 'waste_types' => ['REL', 'OTC']], '21' => ['$any' => true],
                '40' => ['$any' => true], '60' => ['$absent' => true]], $c['customers']);
        },
        'missing_holiday_years: years in range or within 60 days that have no holidays' => function () use ($env, $cal) {
            T::eq([2028], $cal($env(), 'view=month&anchor=2027-12-15')['missing_holiday_years']);
            $only2026 = ['holidays' => [['date' => '2026-12-25', 'name' => 'Christmas Day']]];
            T::eq([2027], $cal($env(['plan' => $only2026]))['missing_holiday_years'], 'today + 60 days reaches 2027');
            T::eq([2027], $cal($env(['plan' => $only2026]), 'view=week&anchor=2027-03-01')['missing_holiday_years']);
            T::eq([], $cal($env(['plan' => ['holidays' => [['date' => '2026-12-25', 'name' => 'X'], ['date' => '2027-01-01', 'name' => 'Y']]]]))['missing_holiday_years']);
        },
        'run overlay today: active, totals, VisitSummary, RunSummary; future dates are planned' => function () use ($env, $cal, $on) {
            $c = $cal($env());
            $n1 = $on($c, 'routes', '2026-11-11')[0];
            T::subset(['key' => 'r5@2026-11-11', 'run_status' => 'active',
                'run' => ['driver' => ['id' => 3, 'name' => 'Ali'], 'vehicle_no' => 'SBA1234X', 'holders' => ['Ali'], 'left_by' => null,
                    'collected' => 1, 'missed' => 0, 'pending' => 1, 'total' => 2, 'totals' => ['REL' => 120.5],
                    'last_activity_at' => '2026-11-11T07:30:00+08:00', 'flagged' => 0],
                'stops' => [['customer_id' => 12, 'visit' => ['outcome' => 'collected', 'weights' => ['REL' => 120.5], 'rev' => 1, 'photos' => 0, 'signature' => false]],
                    ['customer_id' => 40, 'visit' => null]]], $n1);
            T::subset([['key' => 't6@2026-11-11', 'run_status' => 'active', 'run' => ['pending' => 1, 'total' => 1], 'visit' => null]], $on($c, 'tasks', '2026-11-11'));
            T::subset([['key' => 'r41@2026-11-12', 'run_status' => 'planned', 'run' => null]], $on($c, 'routes', '2026-11-12'));
        },
        'R22 statuses: not_started, open, done, off_plan visits; a give-back with nothing done is not_started' => function () use ($env, $cal, $on) {
            $hold = static fn (int $d, ?string $end) => ['driver_id' => $d, 'vehicle_no' => 'SBA1234X', 'by' => 'self', 'from' => '2026-11-11T07:30:00+08:00',
                'to' => $end === null ? null : '2026-11-11T08:00:00+08:00', 'end' => $end];
            $visit = static fn (int $cid, string $o) => ['customer_id' => $cid, 'outcome' => $o, 'weights' => $o === 'collected' ? ['REL' => 10] : [],
                'rev' => 1, 'flags' => $cid === 21 ? ['OFF_PLAN'] : [], 'received_at' => '2026-11-11T09:00:00+08:00', 'driver_id' => 4];
            $days = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'dropped_runs' => [], 'runs' => [
                'r5' => ['job' => 'r5', 'driver_id' => null, 'holds' => [$hold(4, 'left')], 'removed' => [],
                    'visits' => ['12' => $visit(12, 'collected'), '21' => $visit(21, 'collected')]],
                't6' => ['job' => 't6', 'driver_id' => null, 'holds' => [$hold(3, 'left')], 'removed' => [], 'visits' => []],
            ]]];
            $c = $cal($env(['days' => $days]));
            T::subset(['run_status' => 'open', 'run' => ['left_by' => 'Bala', 'driver' => null, 'collected' => 2, 'pending' => 1, 'total' => 3,
                'totals' => ['REL' => 20], 'flagged' => 1, 'last_activity_at' => '2026-11-11T09:00:00+08:00'],
                'off_plan' => [['customer_id' => 21, 'visit' => ['outcome' => 'collected', 'driver' => 'Bala', 'flags' => ['OFF_PLAN']]]]],
                $on($c, 'routes', '2026-11-11')[0]);
            T::eq('not_started', $on($c, 'tasks', '2026-11-11')[0]['run_status'], 'given back with nothing done');
            $days['2026-11-11']['runs']['r5']['visits']['40'] = $visit(40, 'missed');
            $c = $cal($env(['days' => $days]));
            T::eq('done', $on($c, 'routes', '2026-11-11')[0]['run_status']);
            T::subset(['ops' => ['done' => 1, 'not_started' => 1, 'open' => 0], 'provisional' => false, 'totals' => ['REL' => 20]], $c['days'][2]);
        },
        'R13 freeze at the rollover: 03:59 is still Wed and live; 04:00 freezes Wed (incomplete / no_record)' => function () use ($env, $cal, $on) {
            $e = $env([], '2026-11-12T03:59:00+08:00');
            $c = $cal($e);
            T::eq('2026-11-11', $c['today']);
            T::eq('2026-11-10', $e->doc('plan')['frozen_through']);
            T::eq(false, $on($c, 'routes', '2026-11-11')[0]['frozen']);
            T::eq('active', $on($c, 'routes', '2026-11-11')[0]['run_status']);
            $e->setNow('2026-11-12T04:00:00+08:00');
            $c = $cal($e);
            T::eq('2026-11-12', $c['today']);
            T::eq('2026-11-11', $e->doc('plan')['frozen_through']);
            $wed = $e->doc('day:2026-11-11');
            T::subset(['plan' => [['key' => 'r5@2026-11-11', 'status' => 'scheduled', 'stops' => ['$len' => 2]], ['key' => 't6@2026-11-11']],
                'runs' => ['r5' => ['driver_id' => 3]]], $wed, 'snapshot written, runs untouched');
            T::subset(['frozen' => true, 'run_status' => 'incomplete', 'rev' => 4], $on($c, 'routes', '2026-11-11')[0]);
            T::subset([['run_status' => 'incomplete']], $on($c, 'tasks', '2026-11-11'));
            T::subset([['key' => 'r41@2026-11-12', 'run_status' => 'not_started', 'frozen' => false]], $on($c, 'routes', '2026-11-12'));
            T::subset(['past' => true, 'can_create' => [], 'ops' => ['incomplete' => 2]], $c['days'][2]);
        },
        'R13: the first request freezes every missing day once; a past job with no run is no_record' => function () use ($env, $cal, $on, $noRuns) {
            $e = $env(['days' => $noRuns, 'plan' => ['frozen_through' => '2026-11-07']]);
            T::ok($e->call('GET', '/api/meta', null, 'mei'));
            T::eq('2026-11-10', $e->doc('plan')['frozen_through']);
            T::eq([], $e->doc('day:2026-11-08')['plan'], 'Sunday 8 Nov: nothing planned, still frozen');
            T::subset(['plan' => [['key' => 'r5@2026-11-09', 'status' => 'holiday_skipped']]], $e->doc('day:2026-11-09'));
            T::subset(['plan' => [['key' => 't3@2026-11-10', 'kind' => 'task']]], $e->doc('day:2026-11-10'));
            $c = $cal($e);
            T::subset([['key' => 't3@2026-11-10', 'run_status' => 'no_record', 'frozen' => true]], $on($c, 'tasks', '2026-11-10'));
            T::subset(['ops' => ['no_record' => 1]], $c['days'][1]);
            T::subset([['key' => 'r5@2026-11-09', 'status' => 'holiday_skipped', 'run_status' => null]], $on($c, 'routes', '2026-11-09'));
        },
        'R13: a frozen day never changes after a template edit, a rename, a holiday edit or a delete' => function () use ($env, $cal, $on, $noRuns) {
            $e = $env(['days' => $noRuns, 'plan' => ['frozen_through' => '2026-11-08']]);
            $before = $on($cal($e), 'routes', '2026-11-10');
            T::eq([], $before, 'no route on Tue 10 Nov');
            $mon = $on($cal($e), 'routes', '2026-11-09')[0];
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'Renamed', 'stops' => [['customer_id' => 21, 'note' => '']], 'days' => [1, 2]], 'mei'));
            T::ok($e->call('PUT', '/api/holidays/2026-11-13', ['name' => 'New PH'], 'mei'), 201);
            $after = $on($cal($e), 'routes', '2026-11-09')[0];
            T::eq($mon['name'], $after['name']);
            T::eq($mon['stops'], $after['stops']);
            T::eq([], $on($cal($e), 'routes', '2026-11-10'), 'the new Tuesday does not reach the frozen Tue 10 Nov');
            T::eq(204, $e->call('DELETE', '/api/routes/5?rev=5', null, 'mei')['status']);
            T::subset([['key' => 'r5@2026-11-09', 'name' => 'North 1', 'code' => 'N1', 'rev' => null, 'frozen' => true]], $on($cal($e), 'routes', '2026-11-09'),
                'a deleted route still renders from its snapshot');
            T::eq([], $on($cal($e), 'routes', '2026-11-11'), 'today is live: the route is gone');
            T::eq('holiday_skipped', $on($cal($e, 'view=week&anchor=2026-11-09'), 'routes', '2026-11-09')[0]['status']);
            // the snapshot written once is never overwritten
            $doc = $e->doc('day:2026-11-09');
            T::eq('North 1', $doc['plan'][0]['name']);
        },
        'R13: CLOCK_BEHIND_FREEZE when frozen_through >= today; nothing is written' => function () use ($env) {
            $e = $env(['plan' => ['frozen_through' => '2026-11-11']], '2026-11-12T03:00:00+08:00');
            $plan = file_get_contents($e->dir . '/plan.json');
            $err = T::err($e->call('GET', '/api/meta', null, 'mei'), 503, 'CLOCK_BEHIND_FREEZE');
            T::eq(['frozen_through' => '2026-11-11', 'today' => '2026-11-11'], $err['details']);
            T::err($e->call('POST', '/api/login', ['username' => 'mei', 'password' => TestEnv::PASSWORD]), 503, 'CLOCK_BEHIND_FREEZE');
            T::err($e->call('PUT', '/api/holidays/2026-11-20', ['name' => 'x'], 'mei'), 503, 'CLOCK_BEHIND_FREEZE');
            T::eq($plan, file_get_contents($e->dir . '/plan.json'));
            T::eq([], $e->doc('audit:2026-11'));
            $e->setNow('2026-11-12T04:00:00+08:00');
            T::ok($e->call('GET', '/api/meta', null, 'mei'));
        },
        'orphan run (job missing from the plan) is shown with orphan = true, never hidden' => function () use ($env, $cal, $on) {
            $e = $env(['plan' => ['routes' => []]]);
            $c = $cal($e);
            T::subset([['key' => 'r5@2026-11-11', 'orphan' => true, 'code' => 'r5', 'run_status' => 'done',
                'stops' => [['customer_id' => 12, 'visit' => ['outcome' => 'collected']]]]], $on($c, 'routes', '2026-11-11'),
                'route gone: only the visited customers are known');
            $n1 = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true)['plan']['routes'][0];
            $e = $env(['plan' => ['routes' => [['days' => [2]] + $n1]]]); // N1 no longer runs on Wednesdays
            T::subset([['key' => 'r5@2026-11-11', 'orphan' => true, 'code' => 'N1', 'run_status' => 'active',
                'stops' => [['customer_id' => 12], ['customer_id' => 40, 'visit' => null]]]], $on($cal($e), 'routes', '2026-11-11'));
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'x'], 'mei')); // an existing orphan does not block other writes
        },
    ];
})();
