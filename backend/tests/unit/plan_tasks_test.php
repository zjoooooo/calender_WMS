<?php
// Tasks (§10.6): R17 validation (non-routable types only, customer registered, recurring only when the
// type allows it), any day incl. Sunday and PH, R18 recurring on PH, R19 overrides and "move one date",
// TASK_FIELD_IMMUTABLE, R11, R20, list/get. Basic fixture: today Wed 2026-11-11.
// Customers: 12 ABC (REL, OTC), 40 Golden Bakery (REL, COMPACTOR), 50 Only OTC Co (OTC), 60 inactive (REL).
// Tasks: 3 COMPACTOR Tue/Fri for 40 (rev 2), 6 OTC 11 Nov for 12 (held by Ali today), 9 OTC 5 Nov, 10 COMPACTOR Mon from 20 Nov.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = []) => TestEnv::make($now, ['fixture' => 'basic'] + $given);
    $post = static fn (TestEnv $e, array $body) => $e->call('POST', '/api/tasks', $body, 'mei');
    $tasksOn = static function (TestEnv $e, string $date): array {
        $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=' . $date, null, 'mei'));
        return array_values(array_filter($cal['tasks'], static fn ($t) => $t['date'] === $date));
    };

    return [
        'R17: one-off OTC tasks on any day: work day, Sunday and PH' => function () use ($env, $post, $tasksOn) {
            $e = $env();
            foreach (['2026-11-12', '2026-11-15', '2026-12-25'] as $n => $d) {
                $t = T::ok($post($e, ['waste_type' => 'OTC', 'customer_id' => 50, 'date' => $d, 'note' => 'sofa']), 201);
                T::subset(['id' => 11 + $n, 'waste_type' => 'OTC', 'customer_id' => 50, 'recurring' => false, 'date' => $d,
                    'start' => null, 'days' => null, 'note' => 'sofa', 'rev' => 1, 'copied_from' => null], $t);
            }
            T::subset([['task_id' => 12, 'status' => 'scheduled', 'run_status' => 'planned', 'kind' => 'task']], $tasksOn($e, '2026-11-15'));
            T::subset(['task_id' => 13, 'status' => 'scheduled'], $tasksOn($e, '2026-12-25')[0]);
            T::eq(['id' => 13, 'waste_type' => 'OTC', 'customer_id' => 50, 'note' => 'sofa', 'rev' => 1, 'date' => '2026-12-25', 'copied_from' => null],
                $e->doc('plan')['tasks'][6], 'stored shape (§4.4)');
        },
        'R17 validation: TYPE_ROUTABLE, CUSTOMER_LACKS_TYPE, CUSTOMER_INACTIVE, RECURRING_NOT_ALLOWED' => function () use ($env, $post) {
            $e = $env();
            T::err($post($e, ['waste_type' => 'REL', 'customer_id' => 12, 'date' => '2026-11-12']), 422, 'TYPE_ROUTABLE');
            T::err($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 12, 'date' => '2026-11-12']), 422, 'CUSTOMER_LACKS_TYPE');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 40, 'date' => '2026-11-12']), 422, 'CUSTOMER_LACKS_TYPE');
            T::err($post($e, ['waste_type' => 'GLS', 'customer_id' => 12, 'date' => '2026-11-12']), 422, 'UNKNOWN_WASTE_TYPE');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 999, 'date' => '2026-11-12']), 422, 'VALIDATION');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 12, 'start' => '2026-11-12', 'days' => [1]]), 422, 'RECURRING_NOT_ALLOWED');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 12, 'date' => '2026-11-10']), 422, 'PAST_DATE_LOCKED');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 12]), 422, 'VALIDATION');
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 12, 'date' => '2026-11-12', 'route' => 5]), 422, 'VALIDATION');
            T::ok($e->call('POST', '/api/customers/50/archive', [], 'mei'));
            T::err($post($e, ['waste_type' => 'OTC', 'customer_id' => 50, 'date' => '2026-11-12']), 422, 'CUSTOMER_INACTIVE');
            $types = array_map(static fn ($t) => $t['code'] === 'OTC' ? ['active' => false] + $t : $t, Seed::WASTE_TYPES);
            $e2 = $env(['plan' => ['waste_types' => $types]]);
            T::subset(['details' => ['inactive' => true]], T::err($post($e2, ['waste_type' => 'OTC', 'customer_id' => 12, 'date' => '2026-11-12']), 422, 'UNKNOWN_WASTE_TYPE'));
        },
        'R17/R18: recurring COMPACTOR task, Sunday allowed, runs on PH; days 1..7' => function () use ($env, $post, $tasksOn) {
            $e = $env();
            T::err($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'start' => '2026-11-12', 'days' => [0]]), 422, 'VALIDATION');
            T::err($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'start' => '2026-11-12', 'days' => []]), 422, 'VALIDATION');
            T::err($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'start' => '2026-11-12', 'days' => [1], 'date' => '2026-11-12']), 422, 'VALIDATION');
            T::err($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'start' => '2026-11-10', 'days' => [1]]), 422, 'PAST_DATE_LOCKED');
            $t = T::ok($post($e, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'start' => '2026-11-12', 'end' => null, 'days' => [7, 5, 5]]), 201);
            T::subset(['recurring' => true, 'days' => [5, 7], 'start' => '2026-11-12', 'end' => null, 'date' => null], $t);
            T::subset([['task_id' => 3], ['task_id' => 11, 'recurring' => true, 'status' => 'scheduled']], $tasksOn($e, '2026-12-25'), 'Fri PH');
            T::subset([['task_id' => 11]], $tasksOn($e, '2026-11-29'), 'Sunday PH');
            T::subset([['task_id' => 11]], $tasksOn($e, '2026-11-15'), 'Sunday');
        },
        'holidays never affect tasks' => function () use ($env, $tasksOn, $noRuns) {
            $e = $env(['days' => $noRuns]);
            T::ok($e->call('PUT', '/api/holidays/2026-11-13', ['name' => 'Company Day'], 'mei'), 201);
            T::subset([['task_id' => 3, 'status' => 'scheduled']], $tasksOn($e, '2026-11-13'));
        },
        'TASK_FIELD_IMMUTABLE: type, customer and kind never change; editable fields subject to R11' => function () use ($env) {
            $e = $env();
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 2, 'waste_type' => 'OTC'], 'mei'), 422, 'TASK_FIELD_IMMUTABLE');
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 2, 'customer_id' => 12], 'mei'), 422, 'TASK_FIELD_IMMUTABLE');
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 2, 'date' => '2026-11-20'], 'mei'), 422, 'TASK_FIELD_IMMUTABLE');
            T::err($e->call('PATCH', '/api/tasks/9', ['rev' => 1, 'days' => [1]], 'mei'), 422, 'TASK_FIELD_IMMUTABLE');
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 1, 'note' => 'x'], 'mei'), 409, 'STALE_REVISION');
            T::subset(['rev' => 3, 'note' => 'Bin at bay 2', 'start' => '2026-11-03', 'waste_type' => 'COMPACTOR'],
                T::ok($e->call('PATCH', '/api/tasks/3', ['rev' => 2, 'note' => 'Bin at bay 2', 'start' => '2026-11-03', 'waste_type' => 'COMPACTOR', 'customer_id' => 40], 'mei')));
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 3, 'start' => '2026-11-04'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('PATCH', '/api/tasks/3', ['rev' => 3, 'end' => '2026-11-09'], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::subset(['days' => [1, 2], 'end' => '2026-12-31', 'rev' => 4],
                T::ok($e->call('PATCH', '/api/tasks/3', ['rev' => 3, 'days' => [2, 1], 'end' => '2026-12-31'], 'mei')));
            T::subset(['date' => '2026-11-20', 'rev' => 2], T::ok($e->call('PATCH', '/api/tasks/9', ['rev' => 1, 'date' => '2026-11-20'], 'mei')),
                'a past one-off can be re-dated to a date >= today');
            T::err($e->call('PATCH', '/api/tasks/9', ['rev' => 2, 'date' => '2026-11-10'], 'mei'), 422, 'PAST_DATE_LOCKED');
        },
        'R19 overrides: skip, note, restore (an empty override is deleted); NOT_AN_OCCURRENCE' => function () use ($env, $tasksOn) {
            $e = $env();
            $r = T::ok($e->call('PUT', '/api/tasks/3/dates/2026-11-13', ['rev' => 2, 'cancelled' => true, 'note' => 'Closed'], 'mei'));
            T::subset(['task' => ['id' => 3, 'rev' => 3], 'occurrence' => ['key' => 't3@2026-11-13', 'status' => 'cancelled', 'edited' => true,
                'note' => 'Closed', 'task_note' => 'Bin at loading bay', 'run_status' => null]], $r);
            T::err($e->call('PUT', '/api/tasks/3/dates/2026-11-14', ['rev' => 3, 'cancelled' => true], 'mei'), 422, 'NOT_AN_OCCURRENCE');
            T::err($e->call('PUT', '/api/tasks/3/dates/2026-11-10', ['rev' => 3, 'cancelled' => true], 'mei'), 422, 'PAST_DATE_LOCKED');
            T::err($e->call('PUT', '/api/tasks/6/dates/2026-11-11', ['rev' => 1, 'cancelled' => true], 'mei'), 422, 'VALIDATION');
            T::ok($e->call('PUT', '/api/tasks/3/dates/2026-11-13', ['rev' => 3, 'cancelled' => false, 'note' => ''], 'mei'));
            T::eq([['task_id' => 10, 'date' => '2026-11-23', 'cancelled' => true, 'note' => 'closed']], $e->doc('plan')['task_overrides']);
            T::subset([['task_id' => 3, 'status' => 'scheduled', 'edited' => false]], $tasksOn($e, '2026-11-13'));
            // note only, then reset
            T::ok($e->call('PUT', '/api/tasks/3/dates/2026-11-17', ['rev' => 4, 'note' => 'gate code 1234'], 'mei'));
            T::subset([['note' => 'gate code 1234', 'edited' => true, 'status' => 'scheduled']], $tasksOn($e, '2026-11-17'));
            T::subset(['occurrence' => ['edited' => false], 'task' => ['rev' => 6]],
                T::ok($e->call('DELETE', '/api/tasks/3/dates/2026-11-17?rev=5', null, 'mei')));
        },
        'R19 move one date: a one-off copy (same customer, type, note) and the source cancelled' => function () use ($env, $tasksOn) {
            $e = $env();
            $r = T::ok($e->call('POST', '/api/tasks/3/dates/2026-11-13/copy', ['rev' => 2, 'to' => '2026-11-21', 'skip_source' => true], 'mei'), 201);
            T::subset(['created' => ['id' => 11, 'waste_type' => 'COMPACTOR', 'customer_id' => 40, 'note' => 'Bin at loading bay',
                'date' => '2026-11-21', 'copied_from' => ['task_id' => 3, 'date' => '2026-11-13'], 'recurring' => false]], $r);
            T::subset([['task_id' => 3, 'status' => 'cancelled', 'covered_by' => [['task_id' => 11, 'date' => '2026-11-21']]]], $tasksOn($e, '2026-11-13'));
            T::subset([['task_id' => 11, 'status' => 'scheduled', 'copied_from' => ['task_id' => 3, 'date' => '2026-11-13']]], $tasksOn($e, '2026-11-21'));
            T::eq(3, T::ok($e->call('GET', '/api/tasks/3', null, 'mei'))['rev']);
            T::err($e->call('POST', '/api/tasks/3/dates/2026-11-13/copy', ['rev' => 3, 'to' => '2026-11-22', 'skip_source' => true], 'mei'),
                422, 'VALIDATION'); // already cancelled
            T::err($e->call('POST', '/api/tasks/11/dates/2026-11-21/copy', ['rev' => 1, 'to' => '2026-11-22', 'skip_source' => true], 'mei'),
                422, 'VALIDATION'); // a one-off is re-dated, not moved
            T::err($e->call('POST', '/api/tasks/3/dates/2026-11-14/copy', ['rev' => 3, 'to' => '2026-11-22'], 'mei'), 422, 'NOT_AN_OCCURRENCE');
            T::err($e->call('POST', '/api/tasks/3/dates/2026-11-17/copy', ['rev' => 3, 'to' => '2026-11-10'], 'mei'), 422, 'PAST_DATE_LOCKED');
        },
        'R19 copy from a past date (re-plan a missed task) reads the frozen plan' => function () use ($env, $noRuns) {
            $e = $env(['days' => $noRuns, 'plan' => ['frozen_through' => '2026-11-04']]);
            T::ok($e->call('GET', '/api/meta', null, 'mei')); // freezes 5..10 Nov
            T::eq(204, $e->call('DELETE', '/api/tasks/9?rev=1', null, 'mei')['status']);
            $r = T::ok($e->call('POST', '/api/tasks/9/dates/2026-11-05/copy', ['to' => '2026-11-12', 'note' => 'retry'], 'mei'), 201);
            T::subset(['created' => ['waste_type' => 'OTC', 'customer_id' => 12, 'date' => '2026-11-12', 'note' => 'retry',
                'copied_from' => ['task_id' => 9, 'date' => '2026-11-05']]], $r);
            T::err($e->call('POST', '/api/tasks/9/dates/2026-11-06/copy', ['to' => '2026-11-12'], 'mei'), 404, 'NOT_FOUND');
            T::err($e->call('POST', '/api/tasks/3/dates/2026-11-06/copy', ['rev' => 2, 'to' => '2026-11-12', 'skip_source' => true], 'mei'), 422, 'VALIDATION');
            T::subset(['created' => ['note' => 'Bin at loading bay', 'copied_from' => ['task_id' => 3, 'date' => '2026-11-06']]],
                T::ok($e->call('POST', '/api/tasks/3/dates/2026-11-06/copy', ['rev' => 2, 'to' => '2026-11-12'], 'mei'), 201));
        },
        'delete removes the task and its overrides' => function () use ($env) {
            $e = $env();
            T::err($e->call('DELETE', '/api/tasks/10?rev=2', null, 'mei'), 409, 'STALE_REVISION');
            T::eq(204, $e->call('DELETE', '/api/tasks/10?rev=1', null, 'mei')['status']);
            T::eq([], $e->doc('plan')['task_overrides']);
            T::err($e->call('GET', '/api/tasks/10', null, 'mei'), 404, 'NOT_FOUND');
        },
        'GET /api/tasks (filters, next date, today status) and /api/tasks/{id}' => function () use ($env) {
            $e = $env();
            $list = T::ok($e->call('GET', '/api/tasks', null, 'mei'));
            T::eq([6, 3, 10], array_column($list, 'id'), 'live only: OTC before COMPACTOR, then customer');
            T::subset(['id' => 6, 'customer' => ['id' => 12, 'code' => 'C0012', 'name' => 'ABC Restaurant'], 'next_date' => '2026-11-11',
                'today_status' => 'active', 'ended' => false], $list[0]);
            T::subset(['id' => 10, 'next_date' => '2026-11-30', 'today_status' => null], $list[2], '23 Nov is skipped');
            T::eq([6, 9], array_column(T::ok($e->call('GET', '/api/tasks?type=OTC&ended=1', null, 'mei')), 'id'));
            T::eq([3, 10], array_column(T::ok($e->call('GET', '/api/tasks?kind=recurring', null, 'mei')), 'id'));
            T::err($e->call('GET', '/api/tasks?kind=weekly', null, 'mei'), 422, 'VALIDATION');
            $one = T::ok($e->call('GET', '/api/tasks/10', null, 'mei'));
            T::subset(['id' => 10, 'customer' => ['id' => 40, 'name' => 'Golden Bakery'], 'next_date' => '2026-11-30',
                'overrides' => [['task_id' => 10, 'date' => '2026-11-23', 'cancelled' => true, 'note' => 'closed']]], $one);
            T::err($e->call('GET', '/api/tasks', null, 'ali'), 403, 'FORBIDDEN');
        },
    ];
})();
