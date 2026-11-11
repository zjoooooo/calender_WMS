<?php
// R26 run invariant on plan writes (§6.11): RUN_EXISTS, release_run -> dropped_runs, holder-less runs with
// nothing resolved dropped without asking, run.removed for pending customers dropped from a live job.
// Basic fixture: today Wed 2026-11-11; r5 (N1) held by Ali with customer 12 collected; t6 (OTC task) held by Ali.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $hold = ['driver_id' => 3, 'vehicle_no' => 'SBA1234X', 'by' => 'self', 'from' => '2026-11-11T07:30:00+08:00', 'to' => null, 'end' => null];
    $day = static fn (array $runs) => ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => $runs, 'dropped_runs' => []]];
    $r5 = static fn (array $visits = [], ?int $driver = 3) => ['job' => 'r5', 'driver_id' => $driver,
        'holds' => [$driver === null ? ['to' => '2026-11-11T08:00:00+08:00', 'end' => 'left'] + $hold : $hold], 'removed' => [], 'visits' => $visits];
    $env = static fn (array $days) => TestEnv::make($now, ['fixture' => 'basic', 'days' => $days]);
    $collected = ['12' => ['customer_id' => 12, 'outcome' => 'collected', 'weights' => ['REL' => 120.5], 'rev' => 1]];

    return [
        'skip today with a held run and nothing done: RUN_EXISTS, then release_run moves it to dropped_runs' => function () use ($env, $day, $r5) {
            $e = $env($day(['r5' => $r5()]));
            $err = T::err($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'cancelled' => true], 'mei'), 409, 'RUN_EXISTS');
            T::eq(['runs' => [['job' => 'r5', 'date' => '2026-11-11', 'code_or_customer' => 'N1', 'driver' => 'Ali', 'driver_id' => 3, 'resolved' => 0]]], $err['details']);
            T::eq(4, $e->doc('plan')['routes'][0]['rev'], 'nothing saved');
            T::true(isset($e->doc('day:2026-11-11')['runs']['r5']));
            $r = T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'cancelled' => true, 'release_run' => true], 'mei'));
            T::subset(['occurrence' => ['status' => 'cancelled', 'run_status' => null, 'run' => null]], $r);
            $d = $e->doc('day:2026-11-11');
            T::eq([], $d['runs']);
            T::subset([['job' => 'r5', 'driver_id' => null, 'dropped_at' => '2026-11-11T10:00:00+08:00',
                'holds' => [['driver_id' => 3, 'to' => '2026-11-11T10:00:00+08:00', 'end' => 'released']]]], $d['dropped_runs']);
        },
        'work done (resolved >= 1) is refused even with release_run' => function () use ($env, $day, $r5, $collected) {
            $e = $env($day(['r5' => $r5($collected)]));
            T::subset(['details' => ['runs' => [['job' => 'r5', 'resolved' => 1]]]],
                T::err($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'cancelled' => true, 'release_run' => true], 'mei'), 409, 'RUN_EXISTS'));
            T::err($e->call('DELETE', '/api/routes/5?rev=4&release_run=1', null, 'mei'), 409, 'RUN_EXISTS');
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'days' => [1, 5], 'release_run' => true], 'mei'), 409, 'RUN_EXISTS');
            T::err($e->call('POST', '/api/routes/5/dates/2026-11-11/copy', ['rev' => 4, 'to' => '2026-11-12', 'skip_source' => true, 'release_run' => true], 'mei'),
                409, 'RUN_EXISTS');
            T::err($e->call('PUT', '/api/holidays/2026-11-11', ['name' => 'Surprise PH', 'release_run' => true], 'mei'), 409, 'RUN_EXISTS');
            T::ok($e->call('POST', '/api/routes/5/dates/2026-11-11/copy', ['rev' => 4, 'to' => '2026-11-12'], 'mei'), 201); // a copy without skip is fine
            T::eq(1, count($e->doc('day:2026-11-11')['runs']));
        },
        'a run with no holder and nothing resolved is dropped without asking' => function () use ($env, $day, $r5) {
            $e = $env($day(['r5' => $r5([], null)]));
            T::eq(204, $e->call('DELETE', '/api/routes/5?rev=4', null, 'mei')['status']);
            T::subset(['runs' => [], 'dropped_runs' => [['job' => 'r5', 'holds' => [['end' => 'left']]]]], $e->doc('day:2026-11-11'));
        },
        'run.removed: a pending customer dropped from a live job is recorded, a visited one is not' => function () use ($env, $day, $r5, $collected) {
            $e = $env($day(['r5' => $r5($collected)]));
            $r = T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 4, 'scope' => 'this', 'stops' => [['customer_id' => 21, 'note' => '']]], 'mei'));
            T::subset(['occurrence' => ['run_status' => 'active', 'stops' => [['customer_id' => 21]],
                'off_plan' => [['customer_id' => 12, 'visit' => ['outcome' => 'collected']]]]], $r);
            T::eq([40], $e->doc('day:2026-11-11')['runs']['r5']['removed']);
            // 40 back (21 dropped while pending), then everything removed: 40 is not repeated
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 5, 'scope' => 'this', 'stops' => [['customer_id' => 40, 'note' => '']]], 'mei'));
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 6, 'scope' => 'this', 'stops' => []], 'mei'));
            T::eq([40, 21], $e->doc('day:2026-11-11')['runs']['r5']['removed'], '21 was pending when dropped; 40 is not repeated');
            T::eq('done', T::ok($e->call('GET', '/api/calendar', null, 'mei'))['routes'][0]['run_status'], 'removing the pending stops completes the run');
        },
        'run.removed through a customer archive, a "following" template replace and a holiday that does not touch the job' => function () use ($env, $day, $r5) {
            $e = $env($day(['r5' => $r5()]));
            T::ok($e->call('PATCH', '/api/customers/40', ['waste_types' => ['COMPACTOR'], 'detach' => true], 'mei'));
            T::eq([40], $e->doc('day:2026-11-11')['runs']['r5']['removed']);
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-11', ['rev' => 5, 'scope' => 'following', 'stops' => [['customer_id' => 21, 'note' => '']]], 'mei'));
            T::eq([40, 12], $e->doc('day:2026-11-11')['runs']['r5']['removed']);
            T::ok($e->call('PUT', '/api/holidays/2026-11-20', ['name' => 'Later PH'], 'mei'), 201);
        },
        'task changes today: move, date change, delete; holidays do not affect task runs' => function () use ($env, $day, $hold) {
            $t6 = ['job' => 't6', 'driver_id' => 3, 'holds' => [$hold], 'removed' => [], 'visits' => []];
            $e = $env($day(['t6' => $t6]));
            T::ok($e->call('PUT', '/api/holidays/2026-11-11', ['name' => 'Surprise PH'], 'mei'), 201);
            T::err($e->call('PATCH', '/api/tasks/6', ['rev' => 1, 'date' => '2026-11-12'], 'mei'), 409, 'RUN_EXISTS');
            T::subset(['details' => ['runs' => [['job' => 't6', 'code_or_customer' => 'OTC ABC Restaurant', 'driver' => 'Ali']]]],
                T::err($e->call('DELETE', '/api/tasks/6?rev=1', null, 'mei'), 409, 'RUN_EXISTS'));
            T::ok($e->call('PATCH', '/api/tasks/6', ['rev' => 1, 'date' => '2026-11-12', 'release_run' => true], 'mei'));
            T::subset(['runs' => [], 'dropped_runs' => [['job' => 't6']]], $e->doc('day:2026-11-11'));
        },
        'a recurring task skipped today with a run; future-date edits never touch runs' => function () use ($env, $day, $hold) {
            $t3 = ['job' => 't3', 'driver_id' => 3, 'holds' => [$hold], 'removed' => [], 'visits' => []];
            $e = TestEnv::make('2026-11-13T10:00:00+08:00', ['fixture' => 'basic', 'days' => ['2026-11-13' => ['date' => '2026-11-13', 'plan' => null,
                'runs' => ['t3' => $t3], 'dropped_runs' => []]]]);
            T::err($e->call('PUT', '/api/tasks/3/dates/2026-11-13', ['rev' => 2, 'cancelled' => true], 'mei'), 409, 'RUN_EXISTS');
            T::err($e->call('POST', '/api/tasks/3/dates/2026-11-13/copy', ['rev' => 2, 'to' => '2026-11-14', 'skip_source' => true], 'mei'), 409, 'RUN_EXISTS');
            T::ok($e->call('PUT', '/api/tasks/3/dates/2026-11-17', ['rev' => 2, 'cancelled' => true], 'mei'));
            T::ok($e->call('POST', '/api/tasks/3/dates/2026-11-13/copy', ['rev' => 3, 'to' => '2026-11-14', 'skip_source' => true, 'release_run' => true], 'mei'), 201);
            T::subset(['runs' => [], 'dropped_runs' => [['job' => 't3']]], $e->doc('day:2026-11-13'));
        },
    ];
})();
