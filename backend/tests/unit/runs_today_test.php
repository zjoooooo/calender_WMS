<?php
// GET /api/driver/today and the JobDetail (§10.9), the R22 status table (calendar overlay, §8.3), the role
// matrix of the run endpoints. Setup: tests/runs_lib.php (today Wed 2026-11-11).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $left = static fn (int $driver, string $end = 'left') => RunsFx::hold($driver, '2026-11-11T07:00:00+08:00', 'SBA1234X', '2026-11-11T08:00:00+08:00', $end);

    return [
        'R22 status table: planned, not_started, active, open, done, incomplete, no_record, null' => function () use ($left) {
            $e = RunsFx::env(['runs' => [
                'r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)]),                                   // active (holder, pending 1)
                'r50' => RunsFx::run('r50', null, [], [$left(4)]),                                    // resolved 0, no holder: not_started
                't6' => RunsFx::run('t6', null, [RunsFx::visit(12, 'collected', ['OTC' => 3.0])], [$left(4)]), // old task run: not a job
            ]]);
            $o = static fn (string $k) => RunsFx::occ($e, $k)['run_status'];
            T::eq('active', $o('r5@2026-11-11'));
            T::eq('not_started', $o('r50@2026-11-11'));
            T::eq(null, RunsFx::occ($e, 't6@2026-11-11'));
            T::eq('not_started', $o('r51@2026-11-11')); // no run
            T::eq('planned', $o('r41@2026-11-12'));
            // open: a run with work done and no holder
            T::ok($e->call('POST', '/api/runs/2026-11-11/r5/release', ['mark_missed' => false], 'mei'));
            T::eq('open', $o('r5@2026-11-11'));
            // resolved 0 with a holder but nothing pending (an empty stop list): not_started
            T::eq('not_started', Runs::status('scheduled', '2026-11-11', '2026-11-11', RunsFx::run('r51', 3), Runs::counts([], RunsFx::run('r51', 3))));
            T::eq(null, Runs::status('cancelled', '2026-11-11', '2026-11-11', null, Runs::counts([1], null)));
            T::eq(null, Runs::status('holiday_skipped', '2026-11-11', '2026-11-11', null, Runs::counts([1], null)));
            // after the rollover: open/active -> incomplete, not_started -> no_record, done stays done
            $e->setNow('2026-11-12T04:00:00+08:00');
            T::eq('incomplete', $o('r5@2026-11-11'));
            T::eq('no_record', $o('r50@2026-11-11'));
            T::eq('no_record', $o('r51@2026-11-11'));
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'));
            $wed = array_values(array_filter($cal['days'], static fn ($d) => $d['date'] === '2026-11-11'))[0];
            // no_record: r50 and the empty A3 (a scheduled occurrence with no run, R22); the old task run counts nowhere
            T::subset(['ops' => ['incomplete' => 1, 'no_record' => 2, 'done' => 0, 'active' => 0, 'open' => 0, 'not_started' => 0], 'provisional' => false,
                'totals' => ['REL' => 10.0, 'OTC' => ['$absent' => true]]], $wed);
            // done, and a claimed job with nothing done is incomplete after the rollover
            $g = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', null, [RunsFx::visit(21)], [$left(4)]), 'r5' => RunsFx::run('r5', 5)]]);
            T::eq('done', RunsFx::occ($g, 'r50@2026-11-11')['run_status']);
            T::eq('active', RunsFx::occ($g, 'r5@2026-11-11')['run_status']);
            $g->setNow('2026-11-12T04:00:00+08:00');
            T::eq('done', RunsFx::occ($g, 'r50@2026-11-11')['run_status']);
            T::eq('incomplete', RunsFx::occ($g, 'r5@2026-11-11')['run_status'], 'a claimed job with nothing done is incomplete');
        },

        'driver today: route cards with their waste type, order, can_take, my route, active types and plates; no tasks' => function () use ($left) {
            $e = RunsFx::env(['runs' => [
                'r5' => RunsFx::run('r5', null, [RunsFx::visit(12, 'collected', ['REL' => 5.0], 'user:4', 1, 4)], [$left(4)]), // open, left by Bala
                'r50' => RunsFx::run('r50', 3),                                                                             // Ali's route
                't11' => RunsFx::run('t11', 3),                                                                             // an old task run
            ]]);
            $d = T::ok($e->call('GET', '/api/driver/today', null, 'ali'));
            T::subset(['today' => '2026-11-11', 'now' => '2026-11-11T10:00:00+08:00', 'day_ends_at' => '2026-11-12T04:00:00+08:00', 'me' => ['id' => 3, 'name' => 'Ali', 'lang' => 'en'],
                'my_route' => ['date' => '2026-11-11', 'job' => 'r50', 'code' => 'A2', 'name' => 'Adhoc today', 'pending' => 1, 'total' => 1,
                    'vehicle_no' => 'SBA1234X', 'assigned' => false],
                'my_tasks' => ['$absent' => true], 'tasks' => ['$absent' => true],
                'trucks' => ['SBA1234X', 'GBA1234X']], $d);
            T::eq(['REL', 'RECYCLING', 'OTC', 'COMPACTOR', 'EROSE'], array_column($d['waste_types'], 'code'));
            // routes: open first, then active; A3 (no stops, no run) is not listed; S1/E9 do not run today
            T::eq(['r5', 'r50'], array_column($d['routes'], 'job'));
            T::subset(['job' => 'r5', 'date' => '2026-11-11', 'code' => 'N1', 'color' => 1, 'type' => 'regular', 'waste_type' => 'REL', 'name' => 'North 1', 'note' => '', 'stops' => 2,
                'first_customers' => ['ABC Restaurant', 'Golden Bakery'], 'status' => 'open', 'driver' => null, 'left_by' => 'Bala',
                'collected' => 1, 'missed' => 0, 'pending' => 1, 'can_take' => true], $d['routes'][0]);
            T::subset(['job' => 'r50', 'status' => 'active', 'driver' => ['id' => 3, 'name' => 'Ali'], 'can_take' => false, 'note' => 'urgent'], $d['routes'][1]);
            // another driver's view: Ali's work is taken
            $b = T::ok($e->call('GET', '/api/driver/today', null, 'bala'));
            T::subset(['my_route' => null], $b);
            T::eq(false, $b['routes'][1]['can_take']);
            // an inactive type leaves the driver's list
            $x = RunsFx::env(['plan' => ['waste_types' => array_map(static fn ($t) => ['active' => $t['code'] !== 'EROSE'] + $t, Seed::WASTE_TYPES)]]);
            T::eq(['REL', 'RECYCLING', 'OTC', 'COMPACTOR'], array_column(T::ok($x->call('GET', '/api/driver/today', null, 'ali'))['waste_types'], 'code'));
        },

        'JobDetail: same shape before and during the run; customer, weigh/ticket types, visit; NOT_TODAY and 404' => function () {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12, 'collected', ['REL' => 12.5])])]]);
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r50', null, 'bala'));
            T::eq(['date' => '2026-11-11', 'job' => 'r50', 'kind' => 'route', 'code' => 'A2', 'color' => 2, 'type' => 'adhoc', 'name' => 'Adhoc today',
                'note' => 'urgent', 'waste_type' => 'REL', 'plan_status' => 'scheduled', 'status' => 'not_started', 'holder' => null, 'mine' => false,
                'vehicle_no' => null, 'progress' => ['collected' => 0, 'missed' => 0, 'pending' => 1, 'total' => 1], 'totals' => [],
                'stops' => [['seq' => 1, 'on_plan' => true, 'stop_note' => 'gate B',
                    'customer' => ['id' => 21, 'code' => 'C0021', 'name' => 'Sunday Market Stall', 'address' => '1 Market St', 'phone' => '', 'note' => ''],
                    'weigh_types' => ['REL'], 'ticket_types' => [], 'also_on' => [], 'visit' => null]]], $j);
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::subset(['status' => 'active', 'holder' => ['id' => 3, 'name' => 'Ali'], 'mine' => true, 'vehicle_no' => 'SBA1234X', 'totals' => ['REL' => 12.5],
                'progress' => ['collected' => 1, 'pending' => 1, 'total' => 2],
                'stops' => [['stop_note' => '3 bins', 'customer' => ['phone' => '+65 9123 4567', 'note' => 'bins at back lane'],
                    'visit' => ['outcome' => 'collected', 'weights' => ['REL' => 12.5], 'driver_id' => 3, 'rev' => 1, 'flags' => [], 'by' => ['$absent' => true]]],
                    ['visit' => null]]], $j);
            T::eq(false, T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'bala'))['mine']);
            T::err($e->call('GET', '/api/driver/runs/2026-11-11/t6', null, 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/runs/2026-11-11/t6', null, 'mei'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/driver/runs/2026-11-12/r41', null, 'ali'), 422, 'NOT_TODAY');
            T::err($e->call('GET', '/api/driver/runs/2026-11-11/r7', null, 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/driver/runs/2026-11-11/r99', null, 'ali'), 404, 'NOT_FOUND');
            // the office reads any date: a future job is planned, a past one comes from its frozen plan
            T::subset(['status' => 'planned', 'holds' => [], 'visits' => []], T::ok($e->call('GET', '/api/runs/2026-11-12/r41', null, 'mei')));
            $e->setNow('2026-11-13T10:00:00+08:00');
            T::subset(['status' => 'incomplete', 'code' => 'N1', 'holds' => [['driver_id' => 3]], 'visits' => ['12' => ['history' => []]]],
                T::ok($e->call('GET', '/api/runs/2026-11-11/r5', null, 'mei')));
            T::subset(['status' => 'no_record'], T::ok($e->call('GET', '/api/runs/2026-11-12/r41', null, 'mei')));
        },

        'roles: driver endpoints are for drivers only, run endpoints for the office; no token is 401' => function () {
            $e = RunsFx::env();
            foreach (['mei', 'admin'] as $u) {
                T::err($e->call('GET', '/api/driver/today', null, $u), 403, 'FORBIDDEN');
                T::err($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, $u), 403, 'FORBIDDEN');
                T::err($e->call('PUT', '/api/driver/runs/2026-11-11/r5/stops/12', RunsFx::body(1, 0), $u), 403, 'FORBIDDEN');
                T::err($e->call('POST', '/api/driver/runs/2026-11-11/r5/release', [], $u), 403, 'FORBIDDEN');
            }
            T::err($e->call('GET', '/api/runs/2026-11-11/r5', null, 'ali'), 403, 'FORBIDDEN');
            T::err($e->call('POST', '/api/runs/2026-11-11/r5/release', ['mark_missed' => true], 'ali'), 403, 'FORBIDDEN');
            T::err($e->call('GET', '/api/driver/today', null), 401, 'UNAUTHORIZED');
            T::err($e->call('GET', '/api/runs/2026-11-11/r5', null), 401, 'UNAUTHORIZED');
            T::ok($e->call('GET', '/api/runs/2026-11-11/r5', null, 'admin'));
            T::err($e->call('GET', '/api/runs/2026-11-11/x5', null, 'mei'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/runs/2026-11-11/r0', null, 'mei'), 404, 'NOT_FOUND');
            // a driver who must change the password cannot claim yet
            $p = RunsFx::env(['given' => ['users' => [TestEnv::user(3, 'ali', 'driver', ['must_change_password' => true])]]]);
            T::err(RunsFx::claim($p, 'r5', 'ali'), 403, 'PASSWORD_CHANGE_REQUIRED');
        },

        'every run write appends one audit line' => function () {
            $e = RunsFx::env();
            T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
            T::ok(RunsFx::put($e, 'r5', 12, RunsFx::body(1, 0), 'ali'));
            T::err(RunsFx::claim($e, 'r5', 'bala'), 409, 'RUN_TAKEN');
            T::subset([['method' => 'POST', 'path' => '/api/driver/runs/2026-11-11/r5/claim', 'username' => 'ali', 'status' => 201, 'body' => ['vehicle_no' => 'SBA1234X']],
                ['method' => 'PUT', 'path' => '/api/driver/runs/2026-11-11/r5/stops/12', 'status' => 200, 'body' => ['op_id' => RunsFx::op(1)]]], $e->doc('audit:2026-11'));
        },
    ];
})();
