<?php
// R23 claim (§10.9, §7.4 T1/T2/T7): order of the checks, vehicle list, one route at a time, switch atomicity,
// finishIdleRouteHold, run reuse. Setup: tests/runs_lib.php (today Wed 2026-11-11, empty day file).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $W = RunsFx::WED;

    return [
        'claim creates the run (201) with a self hold; the plate is normalised; JobDetail is mine' => function () use ($W) {
            $e = RunsFx::env();
            $d = T::ok(RunsFx::claim($e, 'r5', 'bala', ['vehicle_no' => ' sba 1234x ']), 201);
            T::subset(['left' => null, 'run' => ['date' => $W, 'job' => 'r5', 'kind' => 'route', 'code' => 'N1', 'status' => 'active',
                'holder' => ['id' => 4, 'name' => 'Bala'], 'mine' => true, 'vehicle_no' => 'SBA1234X',
                'progress' => ['collected' => 0, 'missed' => 0, 'pending' => 2, 'total' => 2],
                'stops' => [['seq' => 1, 'customer' => ['id' => 12, 'name' => 'ABC Restaurant']], ['seq' => 2, 'customer' => ['id' => 40]]]]], $d);
            T::eq(['job' => 'r5', 'driver_id' => 4, 'holds' => [['driver_id' => 4, 'vehicle_no' => 'SBA1234X', 'by' => 'self',
                'from' => '2026-11-11T10:00:00+08:00', 'to' => null, 'end' => null]], 'removed' => [], 'visits' => []], RunsFx::diskRun($e, 'r5'));
            T::eq('active', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
        },

        'claim order: NOT_TODAY, 404, already mine (200, plate updated), RUN_TAKEN, NOT_RUNNABLE, VEHICLE_*' => function () use ($W) {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)])]]);
            T::subset(['details' => ['today' => $W]], T::err(RunsFx::claim($e, 'r41', 'ali', ['vehicle_no' => 'SBA1234X'], '2026-11-12'), 422, 'NOT_TODAY'));
            T::err(RunsFx::claim($e, 'r41', 'ali', ['vehicle_no' => 'SBA1234X'], '2026-11-10'), 422, 'NOT_TODAY');
            T::err(RunsFx::claim($e, 'r99', 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('POST', "/api/driver/runs/$W/x5/claim", ['vehicle_no' => 'SBA1234X'], 'ali'), 404, 'NOT_FOUND');
            T::err(RunsFx::claim($e, 'r5', 'ali', ['vehicle_no' => 'SBA1234X'], '2026-13-01'), 422, 'VALIDATION');
            // 2. already mine: 200, the plate of the open hold is updated, no new hold
            T::subset(['run' => ['mine' => true, 'vehicle_no' => 'GBA1234X'], 'left' => null], T::ok(RunsFx::claim($e, 'r5', 'ali', ['vehicle_no' => 'gba1234x'])));
            T::eq(1, count(RunsFx::diskRun($e, 'r5')['holds']));
            T::eq('GBA1234X', RunsFx::diskRun($e, 'r5')['holds'][0]['vehicle_no']);
            T::ok(RunsFx::claim($e, 'r5', 'ali', []), 200); // no plate sent: nothing to update
            T::err(RunsFx::claim($e, 'r5', 'ali', ['vehicle_no' => 'NOPE1']), 422, 'VEHICLE_UNKNOWN');
            // 3. another driver holds it
            $err = T::err(RunsFx::claim($e, 'r5', 'bala'), 409, 'RUN_TAKEN');
            T::eq(['driver' => 'Ali', 'since' => '2026-11-11T07:30:00+08:00', 'collected' => 1, 'total' => 2], $err['details']);
            // 4. scheduled with pending >= 1
            T::err(RunsFx::claim($e, 'r51', 'bala'), 422, 'NOT_RUNNABLE'); // no stops
            T::err(RunsFx::claim($e, 'r7', 'bala'), 422, 'NOT_RUNNABLE'); // S1 does not run on Wednesday
            T::err(RunsFx::claim($e, 'r8', 'bala'), 422, 'NOT_RUNNABLE'); // E9 ended
            // 5. plate required and from the active list (checked after the job)
            T::err(RunsFx::claim($e, 'r50', 'bala', []), 422, 'VEHICLE_REQUIRED');
            T::err(RunsFx::claim($e, 'r50', 'bala', ['vehicle_no' => '  ']), 422, 'VEHICLE_REQUIRED');
            T::subset(['field' => 'vehicle_no', 'details' => ['plate' => 'OLD999Z']], T::err(RunsFx::claim($e, 'r50', 'bala', ['vehicle_no' => 'old 999z']), 422, 'VEHICLE_UNKNOWN'));
            T::err(RunsFx::claim($e, 'r50', 'bala', ['vehicle_no' => 'SBA1234X', 'extra' => 1]), 422, 'VALIDATION');
            // roles: only drivers claim
            T::err(RunsFx::claim($e, 'r50', 'mei'), 403, 'FORBIDDEN');
            T::err(RunsFx::claim($e, 'r50', 'admin'), 403, 'FORBIDDEN');
            T::eq(null, RunsFx::diskRun($e, 'r50'), 'nothing was written by the refused claims');
        },

        'a done job (pending 0) is NOT_RUNNABLE, also when its last holder never finished' => function () {
            $e = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', 3, [RunsFx::visit(21)])]]);
            T::err(RunsFx::claim($e, 'r50', 'bala'), 422, 'NOT_RUNNABLE');
            $e = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', null, [RunsFx::visit(21, 'missed')],
                [RunsFx::hold(3, '2026-11-11T08:00:00+08:00', 'SBA1234X', '2026-11-11T08:30:00+08:00', 'left')])]]);
            T::err(RunsFx::claim($e, 'r50', 'bala'), 422, 'NOT_RUNNABLE');
        },

        'one route at a time: a second route gives DRIVER_HAS_ACTIVE_RUN; switch is atomic; the old task jobs cannot be claimed' => function () {
            $e = RunsFx::env();
            T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
            foreach (['t6', 't11', 't12'] as $t) {
                T::err(RunsFx::claim($e, $t, 'ali'), 404, 'NOT_FOUND');
                T::err($e->call('GET', "/api/driver/runs/2026-11-11/$t", null, 'ali'), 404, 'NOT_FOUND');
            }
            $err = T::err(RunsFx::claim($e, 'r50', 'ali'), 409, 'DRIVER_HAS_ACTIVE_RUN');
            T::eq(['job' => 'r5', 'code' => 'N1', 'pending' => 2], $err['details']);
            // the target is taken: nothing changes, Ali keeps N1
            T::ok(RunsFx::claim($e, 'r50', 'bala'), 201);
            T::err(RunsFx::claim($e, 'r50', 'ali', ['vehicle_no' => 'SBA1234X', 'switch' => true]), 409, 'RUN_TAKEN');
            T::err(RunsFx::claim($e, 'r51', 'ali', ['vehicle_no' => 'SBA1234X', 'switch' => true]), 422, 'NOT_RUNNABLE');
            T::err(RunsFx::claim($e, 'r50', 'ali', ['switch' => true]), 409, 'RUN_TAKEN');
            T::subset(['driver_id' => 3, 'holds' => [['driver_id' => 3, 'to' => null, 'end' => null]]], RunsFx::diskRun($e, 'r5'));
            // Bala gives A2 back (nothing done: Available again, the run is kept), Ali switches to it
            T::eq(['result' => 'not_started'], T::ok($e->call('POST', '/api/driver/runs/2026-11-11/r50/release', ['mark_missed' => false], 'bala')));
            $d = T::ok(RunsFx::claim($e, 'r50', 'ali', ['vehicle_no' => 'SBA1234X', 'switch' => true]), 200); // run reused: 200
            T::eq(['job' => 'r5', 'result' => 'not_started'], $d['left']);
            T::subset(['driver_id' => null, 'holds' => [['driver_id' => 3, 'to' => '2026-11-11T10:00:00+08:00', 'end' => 'switched']]], RunsFx::diskRun($e, 'r5'));
            T::subset(['driver_id' => 3, 'holds' => [['driver_id' => 4, 'end' => 'left'], ['driver_id' => 3, 'by' => 'self', 'end' => null]]], RunsFx::diskRun($e, 'r50'));
            T::eq(['r5', 'r50'], array_keys($e->doc('day:2026-11-11')['runs']), 'no task run was created');
            T::eq('not_started', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
        },

        'switch with work done: the old route becomes open (Needs driver), its visits stay with the old driver' => function () {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)])]]);
            $d = T::ok(RunsFx::claim($e, 'r50', 'ali', ['vehicle_no' => 'SBA1234X', 'switch' => true]), 201);
            T::eq(['job' => 'r5', 'result' => 'open'], $d['left']);
            $o = RunsFx::occ($e, 'r5@2026-11-11');
            T::subset(['run_status' => 'open', 'run' => ['driver' => null, 'left_by' => 'Ali', 'collected' => 1, 'pending' => 1]], $o);
            // T2: anyone (here Bala) picks the open job up; the earlier visit keeps its driver
            T::ok(RunsFx::claim($e, 'r5', 'bala'), 200);
            T::eq(3, RunsFx::diskRun($e, 'r5')['visits']['12']['driver_id']);
            T::subset(['run_status' => 'active', 'run' => ['driver' => ['id' => 4], 'holders' => ['Ali', 'Bala']]], RunsFx::occ($e, 'r5@2026-11-11'));
        },

        'finishIdleRouteHold: a held route with nothing pending is finished by the next route claim' => function () {
            $e = RunsFx::env(['runs' => ['r50' => RunsFx::run('r50', 3, [RunsFx::visit(21)])]]);
            T::eq('done', RunsFx::occ($e, 'r50@2026-11-11')['run_status']);
            $d = T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
            T::eq(null, $d['left']);
            T::subset(['driver_id' => null, 'holds' => [['end' => 'finished', 'to' => '2026-11-11T10:00:00+08:00']]], RunsFx::diskRun($e, 'r50'));
        },

        'the first confirm wins: a second driver gets RUN_TAKEN and nothing is written' => function () {
            $e = RunsFx::env();
            T::ok(RunsFx::claim($e, 'r50', 'chong'), 201);
            $before = $e->doc('day:2026-11-11');
            T::subset(['details' => ['driver' => 'Chong', 'collected' => 0, 'total' => 1]], T::err(RunsFx::claim($e, 'r50', 'bala'), 409, 'RUN_TAKEN'));
            T::eq($before, $e->doc('day:2026-11-11'));
        },

        'a cancelled or holiday-skipped occurrence is not runnable' => function () {
            $e = RunsFx::env(['plan' => ['route_overrides' => [['route_id' => 5, 'date' => '2026-11-11', 'cancelled' => true, 'stops' => null, 'note' => '']]]]);
            T::err(RunsFx::claim($e, 'r5', 'ali'), 422, 'NOT_RUNNABLE');
            $ph = RunsFx::env(['plan' => ['holidays' => [['date' => '2026-11-11', 'name' => 'Test PH']]]]);
            T::err(RunsFx::claim($ph, 'r5', 'ali'), 422, 'NOT_RUNNABLE');
        },
    ];
})();
