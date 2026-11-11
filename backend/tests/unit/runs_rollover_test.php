<?php
// §13 "Operational day and rollover" for runs (R1, R13, R22-R28): jobs dated Wed 2026-11-11 and Thu 2026-11-12,
// rollover 04:00. At 03:59 Wednesday is still today; at 04:00 Wednesday is frozen and past.
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $put = [RunsFx::class, 'put'];
    $b = [RunsFx::class, 'body'];
    $wedRuns = ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)]), 't11' => RunsFx::run('t11', 3)];

    return [
        '03:59 on Thu: Wednesday is still today for claims, lists, plan writes, statuses and results' => function () use ($put, $b, $wedRuns) {
            $e = RunsFx::env(['runs' => $wedRuns]);
            $e->setNow('2026-11-12T03:59:00+08:00');
            T::ok(RunsFx::claim($e, 'r50', 'bala'), 201);
            T::err(RunsFx::claim($e, 'r41', 'chong', ['vehicle_no' => 'SBA1234X'], '2026-11-12'), 422, 'NOT_TODAY');
            $t = T::ok($e->call('GET', '/api/driver/today', null, 'ali'));
            T::subset(['today' => '2026-11-11', 'now' => '2026-11-12T03:59:00+08:00', 'my_route' => ['job' => 'r5', 'date' => '2026-11-11']], $t);
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'note' => 'night shift'], 'mei'));
            T::eq('2026-11-10', $e->doc('plan')['frozen_through'], 'Wednesday is not frozen');
            T::eq('active', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
            $r = T::ok($put($e, 't11', 50, $b(1, 0, 'collected', ['weights' => ['OTC' => 5], 'captured_at' => '2026-11-12T03:58:30+08:00']), 'ali'));
            T::eq([], $r['visit']['flags'], 'no LATE');
            $wed = array_values(array_filter(T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'))['days'],
                static fn ($d) => $d['date'] === '2026-11-11'))[0];
            T::subset(['past' => false, 'totals' => ['REL' => 10.0, 'OTC' => 5.0], 'provisional' => true], $wed);
        },

        '04:00 on Thu: the first request freezes Wednesday; Wed jobs are NOT_TODAY, incomplete / no_record; late results are LATE' => function () use ($put, $b, $wedRuns) {
            $e = RunsFx::env(['runs' => $wedRuns]);
            $e->setNow('2026-11-12T03:59:00+08:00');
            T::ok(RunsFx::claim($e, 'r50', 'bala'), 201);
            $e->setNow('2026-11-12T04:00:00+08:00');
            T::ok($e->call('GET', '/api/meta', null, 'ali'));
            T::eq('2026-11-11', $e->doc('plan')['frozen_through']);
            T::true(is_array($e->doc('day:2026-11-11')['plan']), 'Wednesday has its frozen plan');
            T::eq(['r5', 't11', 'r50'], array_keys($e->doc('day:2026-11-11')['runs']), 'the freeze keeps the runs');
            T::err(RunsFx::claim($e, 'r5', 'chong'), 422, 'NOT_TODAY');
            T::ok(RunsFx::claim($e, 'r41', 'bala', ['vehicle_no' => 'GBA1234X'], '2026-11-12'), 201); // Wed's r50 is no longer held
            T::err($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'note' => 'x'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::eq('incomplete', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
            T::eq('incomplete', RunsFx::occ($e, 'r50@2026-11-11')['run_status']);
            T::eq('no_record', RunsFx::occ($e, 't6@2026-11-11')['run_status']);
            // the Wed holder can no longer leave or finish; only the office closes out a past run
            T::err($e->call('POST', '/api/driver/runs/2026-11-11/r5/release', ['mark_missed' => false], 'ali'), 422, 'NOT_TODAY');
            T::err($e->call('POST', '/api/driver/runs/2026-11-11/r50/release', ['mark_missed' => true, 'reason' => 'closed'], 'bala'), 422, 'NOT_TODAY');
            T::err($e->call('POST', '/api/runs/2026-11-11/r50/assign', ['driver_id' => 5], 'mei'), 422, 'NOT_TODAY');
            T::err($e->call('POST', '/api/runs/2026-11-11/r50/release', ['mark_missed' => false], 'mei'), 422, 'NOT_TODAY');
            // a first result on Wednesday is still accepted, with LATE (captured after the rollover)
            $r = $put($e, 'r5', 40, $b(1, 0, 'collected', ['captured_at' => '2026-11-12T04:00:00+08:00']), 'ali');
            T::eq(['LATE'], T::ok($r)['visit']['flags']);
            T::eq('done', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
            // the driver app shows Thursday only
            $t = T::ok($e->call('GET', '/api/driver/today', null, 'ali'));
            T::subset(['today' => '2026-11-12', 'my_route' => null, 'my_tasks' => []], $t);
            T::eq(['r41'], array_column($t['routes'], 'job'));
            T::err($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'), 422, 'NOT_TODAY');
            // the office closes out the incomplete run and back-fills a no_record job
            T::eq(['result' => 'done'], T::ok($e->call('POST', '/api/runs/2026-11-11/r50/release', ['mark_missed' => true], 'mei')));
            T::subset(['driver_id' => null, 'holds' => [['driver_id' => 4, 'end' => 'finished']], 'visits' => ['21' => ['reason' => 'not_visited']]],
                RunsFx::diskRun($e, 'r50'));
            T::ok($put($e, 't6', 12, $b(2, 0, 'collected', ['weights' => ['OTC' => 9], 'driver_id' => 3]), 'mei', RunsFx::WED, true));
            T::subset(['run_status' => 'done', 'run' => ['driver' => null]], RunsFx::occ($e, 't6@2026-11-11'));
            T::eq('no_record', RunsFx::occ($e, 't12@2026-11-11')['run_status']);
            T::eq(['result' => 'done'], T::ok($e->call('POST', '/api/runs/2026-11-11/t12/release', ['mark_missed' => true], 'mei')));
        },

        'a task deleted after its day was frozen still renders and takes results' => function () use ($put, $b) {
            $e = RunsFx::env(['runs' => ['t11' => RunsFx::run('t11', 3)]]);
            $e->setNow('2026-11-12T10:00:00+08:00');
            T::ok($e->call('GET', '/api/meta', null, 'mei')); // freezes Wednesday
            T::eq(204, $e->call('DELETE', '/api/tasks/11?rev=1', null, 'mei')['status']);
            T::subset(['status' => 'incomplete', 'waste_type' => 'OTC', 'stops' => [['customer' => ['id' => 50]]]], T::ok($e->call('GET', '/api/runs/2026-11-11/t11', null, 'mei')));
            T::subset(['visit' => ['flags' => ['LATE']]], T::ok($put($e, 't11', 50, $b(1, 0, 'collected', ['weights' => ['OTC' => 2]]), 'ali')));
        },
    ];
})();
