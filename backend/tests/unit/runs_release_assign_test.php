<?php
// R24 leave / finish / release / close out / assign, R21 close-out on a job with no run, driver deactivation,
// and the /api/drivers list (R25). Setup: tests/runs_lib.php (today Wed 2026-11-11).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $W = RunsFx::WED;
    $rel = static fn (TestEnv $e, string $job, array $body, string $as, string $date = RunsFx::WED, bool $office = false)
        => $e->call('POST', ($office ? '/api/runs/' : '/api/driver/runs/') . "$date/$job/release", $body, $as);
    $assign = static fn (TestEnv $e, string $job, array $body, string $date = RunsFx::WED)
        => $e->call('POST', "/api/runs/$date/$job/assign", $body, 'mei');

    return [
        'leave with nothing done: not_started again, the run and its holds are kept; finish ends with finished' => function () use ($rel) {
            $e = RunsFx::env();
            T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
            T::eq(['result' => 'not_started'], T::ok($rel($e, 'r5', ['mark_missed' => false], 'ali')));
            T::subset(['driver_id' => null, 'holds' => [['driver_id' => 3, 'to' => '2026-11-11T10:00:00+08:00', 'end' => 'left']]], RunsFx::diskRun($e, 'r5'));
            T::subset(['run_status' => 'not_started', 'run' => ['driver' => null, 'left_by' => 'Ali', 'released_by_office' => false]], RunsFx::occ($e, 'r5@2026-11-11'));
            $today = T::ok($e->call('GET', '/api/driver/today', null, 'bala'));
            T::eq(['r50', 'r5'], array_column($today['routes'], 'job'), 'same status: by code (A2 before N1)');
            T::subset(['job' => 'r5', 'status' => 'not_started', 'can_take' => true, 'left_by' => 'Ali', 'released_by_office' => false], $today['routes'][1]);
            // finish: a route with nothing pending
            T::ok(RunsFx::claim($e, 'r50', 'ali'), 201);
            T::ok(RunsFx::put($e, 'r50', 21, RunsFx::body(1, 0), 'ali'));
            T::eq(['result' => 'done'], T::ok($rel($e, 'r50', ['mark_missed' => true, 'reason' => 'other'], 'ali')), 'mark_missed is ignored when nothing is pending');
            T::subset(['driver_id' => null, 'holds' => [['end' => 'finished']]], RunsFx::diskRun($e, 'r50'));
            T::eq('done', RunsFx::occ($e, 'r50@2026-11-11')['run_status']);
        },

        'leave with mark_missed: pending stops become missed with the reason; "other" needs a note; NOT_HOLDER' => function () use ($rel) {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)])]]);
            T::err($rel($e, 'r5', ['mark_missed' => true, 'reason' => 'other'], 'ali'), 422, 'REASON_REQUIRED');
            T::err($rel($e, 'r5', ['mark_missed' => true, 'reason' => 'gone'], 'ali'), 422, 'VALIDATION');
            T::err($rel($e, 'r5', ['mark_missed' => false], 'bala'), 409, 'NOT_HOLDER');
            T::err($rel($e, 'r50', ['mark_missed' => false], 'ali'), 409, 'NOT_HOLDER');
            T::err($rel($e, 'r5', ['mark_missed' => false], 'mei'), 403, 'FORBIDDEN');
            T::eq(['result' => 'done'], T::ok($rel($e, 'r5', ['mark_missed' => true, 'reason' => 'other', 'note' => 'truck breakdown'], 'ali')));
            $run = RunsFx::diskRun($e, 'r5');
            T::subset(['customer_id' => 40, 'outcome' => 'missed', 'reason' => 'other', 'note' => 'truck breakdown', 'weights' => [],
                'driver_id' => 3, 'by' => 'user:3', 'rev' => 1, 'customer' => ['code' => 'C0040', 'name' => 'Golden Bakery'], 'received_at' => '2026-11-11T10:00:00+08:00'],
                $run['visits']['40']);
            T::eq('collected', $run['visits']['12']['outcome'], 'resolved stops are not touched');
            T::subset(['driver_id' => null, 'holds' => [['end' => 'finished']]], $run);
            T::subset(['run_status' => 'done', 'run' => ['collected' => 1, 'missed' => 1, 'pending' => 0]], RunsFx::occ($e, 'r5@2026-11-11'));
        },

        'office Release (end released) and Close out; close out on a job with no run creates a holder-less run' => function () use ($rel) {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)])]]);
            T::eq(['result' => 'open'], T::ok($rel($e, 'r5', ['mark_missed' => false], 'mei', RunsFx::WED, true)));
            T::subset(['driver_id' => null, 'holds' => [['end' => 'released', 'to' => '2026-11-11T10:00:00+08:00', 'closed_by' => 'user:2']]], RunsFx::diskRun($e, 'r5'));
            // DRV-5: the office took it back, so it is not "left by Ali"
            T::subset(['run_status' => 'open', 'run' => ['left_by' => null, 'released_by_office' => true]], RunsFx::occ($e, 'r5@2026-11-11'));
            T::subset(['job' => 'r5', 'status' => 'open', 'left_by' => null, 'released_by_office' => true],
                array_values(array_filter(T::ok($e->call('GET', '/api/driver/today', null, 'bala'))['routes'], static fn ($r) => $r['job'] === 'r5'))[0]);
            T::subset(['message' => 'This job has no driver to release'], T::err($rel($e, 'r5', ['mark_missed' => false], 'mei', RunsFx::WED, true), 409, 'NOT_HOLDER'));
            T::err($rel($e, 'r50', [], 'mei', RunsFx::WED, true), 409, 'NOT_HOLDER');
            // close out an open run: default reason not_visited
            T::eq(['result' => 'done'], T::ok($rel($e, 'r5', ['mark_missed' => true, 'note' => 'customer called off'], 'mei', RunsFx::WED, true)));
            T::subset(['outcome' => 'missed', 'reason' => 'not_visited', 'note' => 'customer called off', 'driver_id' => null, 'by' => 'user:2'],
                RunsFx::diskRun($e, 'r5')['visits']['40']);
            // close out a not_started job: a holder-less run with every stop missed (R21)
            T::eq(['result' => 'done'], T::ok($rel($e, 'r50', ['mark_missed' => true], 'mei', RunsFx::WED, true)));
            T::subset(['job' => 'r50', 'driver_id' => null, 'holds' => [], 'visits' => ['21' => ['outcome' => 'missed', 'reason' => 'not_visited']]], RunsFx::diskRun($e, 'r50'));
            T::subset(['run_status' => 'done', 'run' => ['missed' => 1]], RunsFx::occ($e, 'r50@2026-11-11'));
            T::err($rel($e, 't11', ['mark_missed' => true, 'reason' => 'closed'], 'admin', RunsFx::WED, true), 404, 'NOT_FOUND'); // an old task job
            T::eq(null, RunsFx::diskRun($e, 't11'));
            // refusals
            T::err($rel($e, 'r7', ['mark_missed' => true], 'mei', RunsFx::WED, true), 404, 'NOT_FOUND'); // not on Wednesday
            T::err($rel($e, 'r41', ['mark_missed' => true], 'mei', '2026-11-12', true), 422, 'NOT_TODAY'); // future
            T::err($rel($e, 'r5', ['mark_missed' => false], 'mei', '2026-11-10', true), 422, 'NOT_TODAY'); // release is for today
            T::err($rel($e, 'r5', ['mark_missed' => true], 'ali', RunsFx::WED, true), 403, 'FORBIDDEN');
            $c = RunsFx::env(['plan' => ['route_overrides' => [['route_id' => 5, 'date' => '2026-11-11', 'cancelled' => true, 'stops' => null, 'note' => '']]]]);
            T::err($rel($c, 'r5', ['mark_missed' => true], 'mei', RunsFx::WED, true), 422, 'NOT_RUNNABLE');
        },

        'assign: not_started -> active(X); X picks a plate with a 200 claim; reassign ends the old hold with reassigned' => function () use ($assign) {
            $e = RunsFx::env();
            $d = T::ok($assign($e, 'r5', ['driver_id' => 4]));
            T::subset(['run' => ['driver' => ['id' => 4, 'name' => 'Bala'], 'vehicle_no' => null, 'pending' => 2, 'total' => 2], 'gave_back' => null], $d);
            T::subset(['driver_id' => 4, 'holds' => [['driver_id' => 4, 'vehicle_no' => null, 'by' => 'user:2', 'from' => '2026-11-11T10:00:00+08:00', 'to' => null]]],
                RunsFx::diskRun($e, 'r5'));
            $today = T::ok($e->call('GET', '/api/driver/today', null, 'bala'));
            T::subset(['job' => 'r5', 'code' => 'N1', 'vehicle_no' => null, 'assigned' => true, 'pending' => 2], $today['my_route']);
            T::subset(['run' => ['mine' => true, 'vehicle_no' => 'GBA1234X']], T::ok(RunsFx::claim($e, 'r5', 'bala', ['vehicle_no' => 'GBA1234X']), 200));
            // reassign to Ali
            T::ok($assign($e, 'r5', ['driver_id' => 3]));
            T::subset(['driver_id' => 3, 'holds' => [['driver_id' => 4, 'vehicle_no' => 'GBA1234X', 'end' => 'reassigned', 'to' => '2026-11-11T10:00:00+08:00'],
                ['driver_id' => 3, 'by' => 'user:2', 'end' => null]]], RunsFx::diskRun($e, 'r5'));
            T::eq(null, T::ok($e->call('GET', '/api/driver/today', null, 'bala'))['my_route']);
            // assigning the current holder again changes nothing
            T::ok($assign($e, 'r5', ['driver_id' => 3]));
            T::eq(2, count(RunsFx::diskRun($e, 'r5')['holds']));
            // refusals
            T::err($assign($e, 'r5', ['driver_id' => 6]), 422, 'VALIDATION'); // inactive driver
            T::err($assign($e, 'r5', ['driver_id' => 2]), 422, 'VALIDATION'); // not a driver
            T::err($assign($e, 'r5', ['driver_id' => 99]), 422, 'VALIDATION');
            T::err($assign($e, 'r5', []), 422, 'VALIDATION');
            T::err($assign($e, 'r41', ['driver_id' => 4], '2026-11-12'), 422, 'NOT_TODAY');
            T::err($assign($e, 'r51', ['driver_id' => 4]), 422, 'NOT_RUNNABLE');
            T::err($assign($e, 'r99', ['driver_id' => 4]), 404, 'NOT_FOUND');
            T::err($e->call('POST', '/api/runs/2026-11-11/r5/assign', ['driver_id' => 4], 'ali'), 403, 'FORBIDDEN');
        },

        'assign runs finishIdleRouteHold(X), then DRIVER_HAS_ACTIVE_RUN unless switch; an old task job cannot be assigned' => function () use ($assign) {
            $e = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', 3)]]);
            T::subset(['details' => ['job' => 'r50', 'code' => 'A2', 'pending' => 1]], T::err($assign($e, 'r5', ['driver_id' => 3]), 409, 'DRIVER_HAS_ACTIVE_RUN'));
            T::err($assign($e, 't6', ['driver_id' => 3]), 404, 'NOT_FOUND');
            $d = T::ok($assign($e, 'r5', ['driver_id' => 3, 'switch' => true]));
            T::eq(['job' => 'r50', 'result' => 'not_started'], $d['gave_back']);
            T::subset(['driver_id' => null, 'holds' => [['end' => 'switched', 'closed_by' => 'user:2']]], RunsFx::diskRun($e, 'r50'));
            // DRV-5: given back by the office for the assign, so not "left by Ali"
            T::subset(['run' => ['left_by' => null, 'released_by_office' => true]], RunsFx::occ($e, 'r50@2026-11-11'));
            T::eq(null, RunsFx::diskRun($e, 't6'));
            // X's idle route (all stops done) is finished first, so it does not block
            $f = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', 4, [RunsFx::visit(21, 'collected', ['REL' => 5.0], 'user:4', 1, 4)])]]);
            T::subset(['gave_back' => null], T::ok($assign($f, 'r5', ['driver_id' => 4])));
            T::subset(['driver_id' => null, 'holds' => [['end' => 'finished']]], RunsFx::diskRun($f, 'r50'));
        },

        'deactivating a driver releases every route job they hold today (end released); old task runs are left as they are' => function () {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)]), 't6' => RunsFx::run('t6', 3), 'r50' => RunsFx::run('r50', 4)]]);
            $t6 = RunsFx::diskRun($e, 't6');
            T::ok($e->call('PATCH', '/api/users/3', ['active' => false], 'admin'));
            T::subset(['driver_id' => null, 'holds' => [['end' => 'released', 'to' => '2026-11-11T10:00:00+08:00']]], RunsFx::diskRun($e, 'r5'));
            T::eq($t6, RunsFx::diskRun($e, 't6'), 'the run of the old task feature is not touched');
            T::eq(4, RunsFx::diskRun($e, 'r50')['driver_id'], "another driver's job is untouched");
            T::eq('open', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
            T::subset(['run' => ['left_by' => null, 'released_by_office' => true]], RunsFx::occ($e, 'r5@2026-11-11'));
        },

        'API-1: a role change away from driver releases every job the driver holds today, like deactivation' => function () {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)]), 't6' => RunsFx::run('t6', 3), 'r50' => RunsFx::run('r50', 4)]]);
            $t6 = RunsFx::diskRun($e, 't6');
            T::subset(['role' => 'office', 'active' => true], T::ok($e->call('PATCH', '/api/users/3', ['role' => 'office'], 'admin')));
            T::subset(['driver_id' => null, 'holds' => [['end' => 'released', 'to' => '2026-11-11T10:00:00+08:00']]], RunsFx::diskRun($e, 'r5'));
            T::eq($t6, RunsFx::diskRun($e, 't6'), 'the run of the old task feature is not touched');
            T::eq(4, RunsFx::diskRun($e, 'r50')['driver_id'], "another driver's job is untouched");
            T::subset(['status' => 'open', 'holder' => null], T::ok($e->call('GET', '/api/runs/2026-11-11/r5', null, 'mei')));
            // a real driver can take the route now (no RUN_TAKEN)
            T::subset(['run' => ['mine' => true]], T::ok(RunsFx::claim($e, 'r5', 'chong')));
            // a change that keeps the driver role (or other users' role changes) releases nothing
            T::ok($e->call('PATCH', '/api/users/5', ['role' => 'driver', 'name' => 'Chong C'], 'admin'));
            T::eq(5, RunsFx::diskRun($e, 'r5')['driver_id']);
        },

        '/api/drivers lists the route job each driver holds today (R25)' => function () {
            $e = RunsFx::env();
            T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
            $list = T::ok($e->call('GET', '/api/drivers', null, 'mei'));
            $ali = array_values(array_filter($list, static fn ($d) => $d['id'] === 3))[0];
            T::subset(['route_job' => ['date' => '2026-11-11', 'job' => 'r5', 'code' => 'N1', 'pending' => 2], 'task_jobs' => ['$absent' => true]], $ali);
            // a legacy task run held by a driver is not a job
            $l = RunsFx::env(['runs' => ['t6' => RunsFx::run('t6', 4)]]);
            $bala = array_values(array_filter(T::ok($l->call('GET', '/api/drivers', null, 'mei')), static fn ($d) => $d['id'] === 4))[0];
            T::eq(null, $bala['route_job']);
        },
    ];
})();
