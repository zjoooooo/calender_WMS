<?php
// One route collects ONE waste type (round 7): picked on create from the active routable types, never
// changed; only customers registered with it are stops; the driver weighs only that type; splits, schedule
// changes and copies keep it; a route stored before round 7 (no waste_type) is a REL route and is not rewritten.
// Basic fixture: today Wed 2026-11-11; customers 12 (REL, OTC), 21 (REL), 40 (REL, COMPACTOR), 50 (OTC).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = []) => TestEnv::make($now, ['fixture' => 'basic', 'days' => $noRuns] + $given);
    $stops = static fn (int ...$ids) => array_map(static fn ($id) => ['customer_id' => $id, 'note' => ''], $ids);
    $route = static function (TestEnv $e, int $id): ?array {
        foreach ($e->doc('plan')['routes'] as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        return null;
    };
    // Customers 12 and 21 also register RECYCLING; then a RECYCLING route R1 (id 45) on Mon/Wed/Fri from today.
    $rcy = static function (TestEnv $e) use ($stops): array {
        T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL', 'RECYCLING', 'OTC']], 'mei'));
        T::ok($e->call('PATCH', '/api/customers/21', ['waste_types' => ['REL', 'RECYCLING']], 'mei'));
        return T::ok($e->call('POST', '/api/routes', ['type' => 'regular', 'waste_type' => 'RECYCLING', 'code' => 'R1', 'name' => 'Recycling 1',
            'start' => '2026-11-11', 'days' => [1, 3, 5], 'stops' => $stops(12, 21)], 'mei'), 201);
    };

    return [
        'create: waste_type is required and must be an active routable type (TYPE_NOT_ROUTABLE)' => function () use ($env, $stops) {
            $e = $env();
            $base = ['type' => 'regular', 'code' => 'W1', 'name' => 'West 1', 'start' => '2026-11-16', 'days' => [1], 'stops' => $stops(12)];
            T::subset(['field' => 'waste_type'], T::err($e->call('POST', '/api/routes', $base, 'mei'), 422, 'VALIDATION'));
            T::subset(['field' => 'waste_type'], T::err($e->call('POST', '/api/routes', $base + ['waste_type' => null], 'mei'), 422, 'VALIDATION'));
            foreach (['OTC', 'COMPACTOR', 'EROSE', 'GLS'] as $code) {
                T::subset(['field' => 'waste_type', 'details' => ['waste_type' => $code]],
                    T::err($e->call('POST', '/api/routes', $base + ['waste_type' => $code], 'mei'), 422, 'TYPE_NOT_ROUTABLE'));
            }
            T::eq(44, $e->doc('plan')['seq']['route'], 'nothing was created');
            $off = $env(['plan' => ['waste_types' => array_map(static fn ($t) => ['active' => $t['code'] !== 'RECYCLING'] + $t, Seed::WASTE_TYPES)]]);
            T::err($off->call('POST', '/api/routes', $base + ['waste_type' => 'RECYCLING'], 'mei'), 422, 'TYPE_NOT_ROUTABLE');
            $r = T::ok($e->call('POST', '/api/routes', $base + ['waste_type' => 'REL'], 'mei'), 201);
            T::eq('REL', $r['waste_type']);
            T::eq('REL', $e->doc('plan')['routes'][6]['waste_type']);
        },

        'a RECYCLING route only takes customers registered with RECYCLING (CUSTOMER_NOT_ROUTABLE), on every stop-list write' => function () use ($env, $stops, $rcy, $route) {
            $e = $env();
            $body = ['type' => 'adhoc', 'waste_type' => 'RECYCLING', 'code' => 'A7', 'name' => 'x', 'date' => '2026-11-12', 'stops' => $stops(12)];
            T::subset(['field' => 'stops.0.customer_id', 'details' => ['customer_id' => 12, 'waste_type' => 'RECYCLING']],
                T::err($e->call('POST', '/api/routes', $body, 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE'));
            $r = $rcy($e);
            T::subset(['id' => 45, 'code' => 'R1', 'waste_type' => 'RECYCLING', 'stops' => $stops(12, 21)], $r);
            T::subset(['rev' => 1, 'waste_type' => 'RECYCLING', 'start' => '2026-11-11'], $route($e, 45));
            // 40 has REL only, 50 OTC only: refused by PATCH, a date override, "following" and change-schedule
            T::err($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'stops' => $stops(12, 40)], 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE');
            T::err($e->call('PUT', '/api/routes/45/dates/2026-11-13', ['rev' => 1, 'scope' => 'this', 'stops' => $stops(50)], 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE');
            T::err($e->call('PUT', '/api/routes/45/dates/2026-11-16', ['rev' => 1, 'scope' => 'following', 'stops' => $stops(21, 40)], 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE');
            T::err($e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-01', 'days' => [2], 'stops' => $stops(40)], 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE');
            T::eq(1, $route($e, 45)['rev'], 'nothing was saved');
            // a REL route still refuses a customer without REL (50), and takes one with REL only (40)
            T::subset(['details' => ['waste_type' => 'REL']], T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'stops' => $stops(12, 50)], 'mei'), 422, 'CUSTOMER_NOT_ROUTABLE'));
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'stops' => $stops(21, 12)], 'mei'));
            // lists and the calendar carry the type
            $rows = array_column(T::ok($e->call('GET', '/api/routes', null, 'mei')), 'waste_type', 'code');
            T::eq(['RECYCLING', 'REL', 'REL'], [$rows['R1'], $rows['N1'], $rows['S1']]);
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'));
            $types = [];
            foreach ($cal['routes'] as $o) {
                if ($o['date'] === '2026-11-11') {
                    $types[$o['code']] = $o['waste_type'];
                }
            }
            T::eq(['N1' => 'REL', 'R1' => 'RECYCLING'], $types);
        },

        'the waste type never changes (TYPE_IMMUTABLE); resending the same value is fine' => function () use ($env, $rcy, $route) {
            $e = $env();
            $rcy($e);
            T::subset(['field' => 'waste_type', 'details' => ['waste_type' => 'RECYCLING']],
                T::err($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'waste_type' => 'REL'], 'mei'), 422, 'TYPE_IMMUTABLE'));
            T::err($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'waste_type' => 'RECYCLING'], 'mei'), 422, 'TYPE_IMMUTABLE');
            T::subset(['waste_type' => 'RECYCLING', 'name' => 'Renamed', 'rev' => 2],
                T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'waste_type' => 'RECYCLING', 'name' => 'Renamed'], 'mei')));
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'waste_type' => 'REL', 'name' => 'North one'], 'mei'));
            T::eq('RECYCLING', $route($e, 45)['waste_type']);
        },

        'a change of schedule, a "following" save and a copy keep the route\'s waste type' => function () use ($env, $stops, $rcy, $route) {
            $e = $env();
            $rcy($e);
            $d = T::ok($e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-01', 'days' => [2, 4]], 'mei'));
            T::subset(['ended' => ['id' => 45, 'waste_type' => 'RECYCLING', 'end' => '2026-11-30'], 'created' => ['id' => 46, 'waste_type' => 'RECYCLING', 'days' => [2, 4]]], $d);
            T::eq('RECYCLING', $route($e, 46)['waste_type']);
            $f = T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-18', ['rev' => 2, 'scope' => 'following', 'stops' => $stops(21)], 'mei'));
            T::subset(['route' => ['id' => 47, 'waste_type' => 'RECYCLING', 'start' => '2026-11-18'], 'occurrence' => ['waste_type' => 'RECYCLING', 'stops' => [['customer_id' => 21]]]], $f);
            T::eq(['RECYCLING', 'RECYCLING', 'RECYCLING'], [$route($e, 45)['waste_type'], $route($e, 46)['waste_type'], $route($e, 47)['waste_type']]);
            $c = T::ok($e->call('POST', '/api/routes/45/dates/2026-11-13/copy', ['rev' => 3, 'to' => '2026-11-14'], 'mei'), 201);
            T::subset(['created' => ['waste_type' => 'RECYCLING', 'date' => '2026-11-14', 'stops' => $stops(12, 21)]], $c);
            T::eq('RECYCLING', $route($e, $c['created']['id'])['waste_type']);
            // a customer that lost RECYCLING since (detached) is not copied
            T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL', 'OTC'], 'detach' => true], 'mei'));
            $c2 = T::ok($e->call('POST', '/api/routes/45/dates/2026-11-16/copy', ['rev' => $route($e, 45)['rev'], 'to' => '2026-11-17'], 'mei'), 201);
            T::eq($stops(21), $c2['created']['stops']);
        },

        'a route stored without a waste type is a REL route and is never given the field' => function () use ($env, $stops, $route) {
            $e = $env();
            T::eq(false, array_key_exists('waste_type', $route($e, 5)));
            T::eq('REL', T::ok($e->call('GET', '/api/routes/5', null, 'mei'))['waste_type']);
            T::subset(['waste_type' => 'REL'], T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'North one', 'stops' => $stops(40, 12)], 'mei')));
            T::subset(['name' => 'North one', 'rev' => 5, 'waste_type' => ['$absent' => true]], $route($e, 5));
            // its split parts stay without the field too (still REL); a copy is a new record and names REL
            $d = T::ok($e->call('POST', '/api/routes/5/change-schedule', ['rev' => 5, 'from' => '2026-12-01', 'days' => [2]], 'mei'));
            T::eq('REL', $d['created']['waste_type']);
            T::eq(false, array_key_exists('waste_type', $route($e, $d['created']['id'])));
            T::eq(false, array_key_exists('waste_type', $route($e, 5)));
            $c = T::ok($e->call('POST', '/api/routes/5/dates/2026-11-13/copy', ['rev' => $route($e, 5)['rev'], 'to' => '2026-11-14'], 'mei'), 201);
            T::eq('REL', $route($e, $c['created']['id'])['waste_type']);
            // a copy from a frozen day whose entry has no type is REL as well
            $p = TestEnv::make('2026-11-11T10:00:00+08:00', ['fixture' => 'basic']);
            $p->setNow('2026-11-12T10:00:00+08:00'); // the first request freezes Wednesday
            $c = T::ok($p->call('POST', '/api/routes/5/dates/2026-11-11/copy', ['rev' => 4, 'to' => '2026-11-12'], 'mei'), 201);
            T::eq('REL', $c['created']['waste_type']);
            $wed = $p->doc('day:2026-11-11')['plan'][0];
            T::eq(['r5@2026-11-11', 'REL'], [$wed['key'], $wed['waste_type']], 'the frozen entry carries the type');
        },

        'the driver weighs only the route\'s type: weigh_types, TYPE_NOT_ALLOWED, totals' => function () use ($env, $rcy) {
            $e = $env();
            $rcy($e);
            T::ok(RunsFx::claim($e, 'r45', 'ali'), 201);
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r45', null, 'ali'));
            T::subset(['kind' => 'route', 'code' => 'R1', 'waste_type' => 'RECYCLING'], $j);
            T::eq([['RECYCLING'], ['RECYCLING']], array_column($j['stops'], 'weigh_types'), 'customer 12 also has REL and OTC: not offered here');
            T::eq('RECYCLING', array_column(T::ok($e->call('GET', '/api/driver/today', null, 'ali'))['routes'], 'waste_type', 'code')['R1']);
            T::subset(['field' => 'weights.REL', 'details' => ['allowed' => ['RECYCLING']]],
                T::err(RunsFx::put($e, 'r45', 12, RunsFx::body(1, 0), 'ali'), 422, 'TYPE_NOT_ALLOWED'));
            T::err(RunsFx::put($e, 'r45', 12, RunsFx::body(2, 0, 'collected', ['weights' => ['RECYCLING' => 5, 'REL' => 5]]), 'ali'), 422, 'TYPE_NOT_ALLOWED');
            $d = T::ok(RunsFx::put($e, 'r45', 12, RunsFx::body(3, 0, 'collected', ['weights' => ['RECYCLING' => 42.5]]), 'ali'));
            T::subset(['visit' => ['weights' => ['RECYCLING' => 42.5]], 'totals' => ['RECYCLING' => 42.5]], $d);
            // the same customer on the REL route N1 that day weighs REL only
            T::ok(RunsFx::claim($e, 'r5', 'bala'), 201);
            T::eq([['REL'], ['REL']], array_column(T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'bala'))['stops'], 'weigh_types'));
            T::err(RunsFx::put($e, 'r5', 12, RunsFx::body(4, 0, 'collected', ['weights' => ['RECYCLING' => 5]]), 'bala'), 422, 'TYPE_NOT_ALLOWED');
            T::ok(RunsFx::put($e, 'r5', 12, RunsFx::body(5, 0, 'collected', ['weights' => ['REL' => 10]]), 'bala'));
            $wed = array_values(array_filter(T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'))['days'],
                static fn ($x) => $x['date'] === '2026-11-11'))[0];
            T::subset(['totals' => ['RECYCLING' => 42.5, 'REL' => 10.0]], $wed);
            // office OFF_PLAN on the RECYCLING route: only a customer registered with RECYCLING
            T::err(RunsFx::put($e, 'r45', 40, RunsFx::body(6, 0, 'collected', ['weights' => ['RECYCLING' => 1]]), 'mei', RunsFx::WED, true), 422, 'NOT_ON_JOB');
        },

        'a type cannot leave a customer on a live route of that type; detach removes it from those routes only' => function () use ($env, $stops, $rcy, $route) {
            $e = $env();
            $rcy($e);
            $err = T::err($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL', 'OTC']], 'mei'), 409, 'CUSTOMER_IN_USE');
            T::eq([['kind' => 'route', 'route_id' => 45, 'code' => 'R1', 'name' => 'Recycling 1', 'where' => 'template', 'date' => null]], $err['details']['routes']);
            T::eq(['routes'], array_keys($err['details']));
            // removing OTC (no route) is free; REL is blocked by the REL routes, not by R1
            T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL', 'RECYCLING']], 'mei'));
            $rel = T::err($e->call('PATCH', '/api/customers/12', ['waste_types' => ['RECYCLING']], 'mei'), 409, 'CUSTOMER_IN_USE');
            T::eq([5, 41, 42, 5], array_column($rel['details']['routes'], 'route_id'));
            $d = T::ok($e->call('PATCH', '/api/customers/12', ['waste_types' => ['REL'], 'detach' => true], 'mei'));
            T::eq([45], array_column($d['removed'], 'route_id'));
            T::eq($stops(21), $route($e, 45)['stops']);
            T::eq([['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']], $route($e, 5)['stops'], 'the REL route keeps the customer');
        },

        'a routable type cannot be deactivated while a live route collects it (WASTE_TYPE_IN_USE)' => function () use ($env, $rcy) {
            $e = $env();
            T::ok($e->call('PATCH', '/api/waste-types/RECYCLING', ['active' => false], 'admin')); // no route collects it yet
            T::ok($e->call('PATCH', '/api/waste-types/RECYCLING', ['active' => true], 'admin'));
            $rcy($e);
            $err = T::err($e->call('PATCH', '/api/waste-types/RECYCLING', ['active' => false], 'admin'), 409, 'WASTE_TYPE_IN_USE');
            T::eq(['routes' => [['route_id' => 45, 'code' => 'R1', 'name' => 'Recycling 1', 'type' => 'regular']]], $err['details']);
            // a split route is listed once
            T::ok($e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-01', 'days' => [2]], 'mei'));
            T::eq(1, count(T::err($e->call('PATCH', '/api/waste-types/RECYCLING', ['active' => false], 'admin'), 409, 'WASTE_TYPE_IN_USE')['details']['routes']));
            T::eq(204, $e->call('DELETE', '/api/routes/45?rev=2', null, 'mei')['status']);
            T::subset(['code' => 'RECYCLING', 'active' => false], T::ok($e->call('PATCH', '/api/waste-types/RECYCLING', ['active' => false], 'admin')));
        },
    ];
})();
