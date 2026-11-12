<?php
// Data of the old task feature (removed in round 7) stays on disk exactly as it was: plan.tasks,
// plan.task_overrides, plan.seq.task, day-file runs keyed t<id> and frozen plan entries of kind "task".
// No write may drop or change it; nothing shows or counts it any more.
// Basic fixture (today Wed 2026-11-11): tasks 3, 6, 9, 10, an override of task 10, a t6 run held by Ali.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $op = static fn (int $n) => sprintf('00000000-0000-4000-8000-%012d', $n);
    $hold = ['driver_id' => 3, 'vehicle_no' => 'SBA1234X', 'by' => 'self', 'from' => '2026-11-11T08:00:00+08:00', 'to' => null, 'end' => null];
    // t6 with a collected visit: its weight must not reach the totals
    $t6 = ['job' => 't6', 'driver_id' => 3, 'holds' => [$hold], 'removed' => [],
        'visits' => ['12' => ['customer_id' => 12, 'outcome' => 'collected', 'weights' => ['OTC' => 99.5], 'rev' => 1]]];
    $r5 = ['job' => 'r5', 'driver_id' => 3, 'holds' => [['from' => '2026-11-11T07:30:00+08:00'] + $hold], 'removed' => [],
        'visits' => ['12' => ['customer_id' => 12, 'outcome' => 'collected', 'weights' => ['REL' => 120.5], 'rev' => 1]]];
    $overrides = [
        ['task_id' => 3, 'date' => '2026-11-06', 'cancelled' => true, 'note' => 'a past date: the old cleanup would have purged it'],
        ['task_id' => 10, 'date' => '2026-11-23', 'cancelled' => true, 'note' => 'closed'],
        ['task_id' => 3, 'date' => '2026-11-17', 'cancelled' => false, 'note' => ''], // a no-op override: the old cleanup would have deleted it
    ];
    $env = static fn (array $days = []) => TestEnv::make($now, ['fixture' => 'basic', 'plan' => ['task_overrides' => $overrides],
        'days' => ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => ['r5' => $r5, 't6' => $t6], 'dropped_runs' => []]] + $days]);
    $legacy = static function (TestEnv $e): array {
        $p = $e->doc('plan');
        return ['tasks' => $p['tasks'], 'task_overrides' => $p['task_overrides'], 'seq.task' => $p['seq']['task'],
            't6' => $e->doc('day:2026-11-11')['runs']['t6']];
    };
    $sub = static fn (TestEnv $e, int $n, string $date = '2026-11-11') => $e->call('PUT', "/api/driver/submissions/$date/" . $op($n),
        ['op_id' => $op($n), 'base_rev' => 0, 'waste_type' => 'OTC', 'customer_id' => 12, 'vehicle_no' => 'SBA1234X', 'outcome' => 'collected',
            'weights' => ['OTC' => 5]], 'ali');
    $visit = static fn (int $n, string $code = 'REL') => ['op_id' => $op($n), 'base_rev' => 0, 'outcome' => 'collected', 'weights' => [$code => 5]];

    return [
        'every kind of write keeps plan.tasks, plan.task_overrides, plan.seq.task and the t6 run exactly as they were' => function () use ($env, $legacy, $sub, $visit) {
            $e = $env();
            $was = $legacy($e);
            T::eq([3, 6, 9, 10], array_column($was['tasks'], 'id'));
            T::eq(3, count($was['task_overrides']));
            T::eq(10, $was['seq.task']);
            $same = static function (string $step) use ($e, $legacy, $was): void {
                T::eq($was, $legacy($e), "after $step");
            };
            // route writes
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'North one', 'days' => [1, 3, 5, 6]], 'mei'));
            T::ok($e->call('POST', '/api/routes', ['type' => 'adhoc', 'waste_type' => 'REL', 'code' => 'A9', 'name' => 'x', 'date' => '2026-11-12',
                'stops' => [['customer_id' => 21, 'note' => '']]], 'mei'), 201);
            T::ok($e->call('PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 5, 'scope' => 'this', 'cancelled' => true], 'mei'));
            T::ok($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 6, 'from' => '2026-12-01', 'days' => [2]], 'mei'));
            T::ok($e->call('POST', '/api/routes/5/dates/2026-11-16/copy', ['rev' => 7, 'to' => '2026-11-17'], 'mei'), 201);
            T::eq(204, $e->call('DELETE', '/api/routes/44?rev=1', null, 'mei')['status']);
            $same('route writes');
            // customer writes: the type of tasks 3 / 10 leaves customer 40; customer 50 is archived; a new customer
            T::ok($e->call('PATCH', '/api/customers/40', ['waste_types' => ['REL'], 'detach' => true], 'mei'));
            T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL'], 'name' => 'ABC'], 'mei'));
            T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL', 'OTC']], 'mei'));
            T::ok($e->call('POST', '/api/customers/50/archive', [], 'mei'));
            T::ok($e->call('POST', '/api/customers', ['name' => 'New', 'waste_types' => ['OTC']], 'mei'), 201);
            $same('customer writes');
            // holiday, trucks and settings writes
            T::ok($e->call('PUT', '/api/holidays/2026-11-20', ['name' => 'New PH'], 'mei'), 201);
            T::eq(204, $e->call('DELETE', '/api/holidays/2026-11-20', null, 'mei')['status']);
            T::ok($e->call('PUT', '/api/trucks', ['trucks' => [['plate' => 'SBA1234X', 'active' => true]]], 'mei'));
            $same('holiday and truck writes');
            // waste-type writes: the types of the old tasks are edited, reordered and deactivated
            T::ok($e->call('PATCH', '/api/waste-types/COMPACTOR', ['active' => false, 'name' => 'Compactor'], 'admin'));
            T::ok($e->call('PUT', '/api/waste-types/order', ['codes' => ['OTC', 'EROSE', 'COMPACTOR', 'RECYCLING', 'REL']], 'admin'));
            T::ok($e->call('POST', '/api/waste-types', ['code' => 'GLS', 'name' => 'Glass'], 'admin'), 201);
            $same('waste-type writes');
            // run and visit writes on today's day file (an assign, a claim of the plate, results, finish), and a free submission
            T::ok($e->call('POST', '/api/runs/2026-11-11/r5/assign', ['driver_id' => 4], 'mei'));
            T::ok($e->call('POST', '/api/driver/runs/2026-11-11/r5/claim', ['vehicle_no' => 'SBA1234X'], 'bala'));
            T::ok($e->call('POST', '/api/runs/2026-11-11/r5/assign', ['driver_id' => 3], 'mei'));
            T::ok($e->call('PUT', '/api/driver/runs/2026-11-11/r5/stops/40', $visit(1), 'ali'));
            T::ok($e->call('PUT', '/api/runs/2026-11-11/r5/stops/40', ['op_id' => sprintf('00000000-0000-4000-8000-%012d', 2), 'base_rev' => 1,
                'outcome' => 'collected', 'weights' => ['REL' => 6], 'why' => 'recheck'], 'mei'));
            T::ok($sub($e, 3), 201);
            T::ok($e->call('POST', '/api/driver/runs/2026-11-11/r5/release', ['mark_missed' => false], 'ali'));
            $same('visit, submission and run writes');
            T::eq(['r5', 't6'], array_keys($e->doc('day:2026-11-11')['runs']));
            // a driver is deactivated (Ali "holds" t6), a user is created
            T::ok($e->call('PATCH', '/api/users/3', ['active' => false], 'admin'));
            T::ok($e->call('POST', '/api/users', ['username' => 'dave', 'name' => 'Dave', 'role' => 'driver', 'lang' => 'en', 'password' => 'password1'], 'admin'), 201);
            $same('user writes');
            // the rollover freezes Wednesday: only the route is frozen, the t6 run stays in the file
            $e->setNow('2026-11-12T04:00:00+08:00');
            T::ok($e->call('GET', '/api/meta', null, 'mei'));
            T::eq('2026-11-11', $e->doc('plan')['frozen_through']);
            $same('the rollover freeze');
            T::eq(['r5@2026-11-11'], array_column($e->doc('day:2026-11-11')['plan'], 'key'));
            // and a plan write on the next day (the old cleanup purged overrides dated before today)
            T::ok($e->call('PUT', '/api/holidays/2026-11-25', ['name' => 'Later PH'], 'mei'), 201);
            $same('a plan write after the rollover');
        },

        'the old tasks are not shown and not counted: calendar, totals, drivers, customers, driver app' => function () use ($env) {
            $e = $env();
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'));
            T::eq(false, array_key_exists('tasks', $cal));
            T::eq([], array_values(array_filter($cal['routes'], static fn ($o) => $o['kind'] !== 'route' || str_starts_with($o['key'], 't'))));
            $wed = array_values(array_filter($cal['days'], static fn ($d) => $d['date'] === '2026-11-11'))[0];
            T::eq(['REL' => 120.5], $wed['totals'], 'the 99.5 kg OTC of the t6 run is not counted');
            T::subset(['ops' => ['active' => 1, 'not_started' => 0, 'open' => 0, 'done' => 0], 'can_create' => ['regular', 'adhoc']], $wed);
            $fri = array_values(array_filter($cal['days'], static fn ($d) => $d['date'] === '2026-11-13'))[0]; // task 3 ran on Tue / Fri
            T::eq([], $fri['totals']);
            T::eq(['r5@2026-11-13'], array_column(array_values(array_filter($cal['routes'], static fn ($o) => $o['date'] === '2026-11-13')), 'key'));
            foreach (['/api/tasks', '/api/tasks/3', '/api/runs/2026-11-11/t6', '/api/driver/runs/2026-11-11/t6'] as $path) {
                T::err($e->call('GET', $path, null, str_contains($path, 'driver') ? 'ali' : 'mei'), 404, 'NOT_FOUND');
            }
            T::err($e->call('POST', '/api/tasks', ['waste_type' => 'OTC', 'customer_id' => 12, 'date' => '2026-11-15'], 'mei'), 404, 'NOT_FOUND');
            $t = T::ok($e->call('GET', '/api/driver/today', null, 'ali'));
            T::eq(false, array_key_exists('tasks', $t) || array_key_exists('my_tasks', $t));
            T::eq(['r5'], array_column($t['routes'], 'job'));
            $ali = array_values(array_filter(T::ok($e->call('GET', '/api/drivers', null, 'mei')), static fn ($d) => $d['id'] === 3))[0];
            T::eq(['id', 'name', 'active', 'route_job'], array_keys($ali));
            T::eq(false, array_key_exists('tasks', T::ok($e->call('GET', '/api/customers/40', null, 'mei'))));
            $recs = T::ok($e->call('GET', '/api/submissions', null, 'mei'));
            T::eq(['today' => '2026-11-11', 'date' => '2026-11-11', 'totals' => [], 'submissions' => []], array_diff_key($recs, ['visits' => 1]),
                'a task visit is not a submission');
            T::eq(['r5/12'], array_column($recs['visits'], 'id'), 'and the day\'s records list the route result only, nothing of the task run');
            // the types of the old tasks have no usage guard any more
            T::ok($e->call('PATCH', '/api/waste-types/OTC', ['active' => false], 'admin'));
        },

        'a frozen day that holds task entries and a task run keeps them through reads and writes on that day' => function () use ($env, $sub, $visit, $op) {
            $taskEntry = ['key' => 't3@2026-11-10', 'kind' => 'task', 'task_id' => 3, 'waste_type' => 'COMPACTOR', 'customer_id' => 40,
                'recurring' => true, 'days' => [2, 5], 'start' => '2026-11-03', 'end' => null, 'copied_from' => null, 'note' => 'Bin at loading bay',
                'status' => 'scheduled', 'edited' => false];
            $routeEntry = ['key' => 'r5@2026-11-10', 'kind' => 'route', 'route_id' => 5, 'code' => 'N1', 'color' => 1, 'type' => 'regular', 'name' => 'North 1',
                'note' => '', 'status' => 'scheduled', 'edited' => false, 'recurring' => true, 'days' => [1, 2, 3], 'sun' => null, 'ph' => null, 'copied_from' => null,
                'stops' => [['customer_id' => 12, 'note' => '']]];
            $t3 = ['job' => 't3', 'driver_id' => null, 'holds' => [], 'removed' => [],
                'visits' => ['40' => ['customer_id' => 40, 'outcome' => 'collected', 'weights' => ['COMPACTOR' => 640.0], 'rev' => 1]]];
            $e = $env(['2026-11-10' => ['date' => '2026-11-10', 'plan' => [$routeEntry, $taskEntry], 'runs' => ['t3' => $t3], 'dropped_runs' => []]]);
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-10', null, 'mei'));
            $tue = array_values(array_filter($cal['days'], static fn ($d) => $d['date'] === '2026-11-10'))[0];
            T::eq([], $tue['totals']);
            T::subset(['ops' => ['no_record' => 1, 'done' => 0, 'incomplete' => 0]], $tue);
            T::eq(['r5@2026-11-10'], array_column(array_values(array_filter($cal['routes'], static fn ($o) => $o['date'] === '2026-11-10')), 'key'));
            T::subset(['waste_type' => 'REL', 'frozen' => true], array_values(array_filter($cal['routes'], static fn ($o) => $o['date'] === '2026-11-10'))[0]);
            // an office back-fill, a close-out and a late submission write the same day file
            T::ok($e->call('PUT', '/api/runs/2026-11-10/r5/stops/12', $visit(1), 'mei'));
            T::ok($e->call('POST', '/api/runs/2026-11-10/r5/release', ['mark_missed' => true], 'mei'));
            T::ok($sub($e, 2, '2026-11-10'), 201);
            T::err($e->call('PUT', '/api/runs/2026-11-10/t3/stops/40', $visit(3, 'COMPACTOR'), 'mei'), 404, 'NOT_FOUND');
            $doc = $e->doc('day:2026-11-10');
            T::eq([$routeEntry, $taskEntry], $doc['plan']);
            T::eq($t3, $doc['runs']['t3']);
            T::eq(['t3', 'r5'], array_keys($doc['runs']));
            T::eq([$op(2)], array_keys($doc['submissions']));
            // a copy from that frozen day finds the route entry, never the task entry
            T::ok($e->call('POST', '/api/routes/5/dates/2026-11-10/copy', ['rev' => 4, 'to' => '2026-11-12'], 'mei'), 201);
            T::eq([$routeEntry, $taskEntry], $e->doc('day:2026-11-10')['plan']);
            $tue = array_values(array_filter(T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-10', null, 'mei'))['days'], static fn ($d) => $d['date'] === '2026-11-10'))[0];
            T::eq(['REL' => 5.0, 'OTC' => 5.0], $tue['totals'], 'the route visit and the submission count; the 640 kg of the t3 run do not');
        },
    ];
})();
