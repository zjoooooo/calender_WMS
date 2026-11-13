<?php
// Schedule (§5): R2 day class, R7 route generation (regular Mon-Sat, PH auto-pause, special Sun/PH once,
// one-offs, overrides), R8 effective stops, R18 tasks (any day, recurring on PH), §5.8 order, R13 snapshot.
// Pure functions on the basic fixture's plan (today = Wed 2026-11-11 in the fixture's comments).
return (static function (): array {
    $plan = static function (array $over = []): array {
        $fx = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true)['plan'];
        return array_replace(Seed::plan('2026-11-11', $GLOBALS['WMS_TEST_CONFIG']['seed_file']), $fx, $over);
    };
    $route = static function (array $p, int $id): array {
        foreach ($p['routes'] as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        T::fail("no route $id");
    };
    $keys = static fn (array $occs): array => array_column($occs, 'key');

    return [
        'R2 day class: Sunday and public holidays are rest days' => function () use ($plan) {
            $p = $plan();
            T::eq('work', Schedule::dayClass($p, '2026-11-11'), 'Wed');
            T::eq('rest', Schedule::dayClass($p, '2026-11-15'), 'Sun');
            T::eq('rest', Schedule::dayClass($p, '2026-12-25'), 'Fri PH');
            T::eq('rest', Schedule::dayClass($p, '2026-11-09'), 'Mon PH (observed)');
            T::eq('work', Schedule::dayClass($p, '2026-11-14'), 'Sat');
        },
        'R7 regular: generated only on its weekdays, never on Sunday' => function () use ($plan, $route) {
            $p = $plan();
            $h = Dates::holidayMap($p);
            $n1 = $route($p, 5); // Mon Wed Fri from 2026-11-02
            T::eq('scheduled', Schedule::routeBaseStatus($n1, '2026-11-11', $h), 'Wed');
            T::eq(null, Schedule::routeBaseStatus($n1, '2026-11-12', $h), 'Thu');
            T::eq('scheduled', Schedule::routeBaseStatus($n1, '2026-11-13', $h), 'Fri');
            T::eq(null, Schedule::routeBaseStatus($n1, '2026-11-15', $h), 'Sun');
            T::eq(null, Schedule::routeBaseStatus($n1, '2026-11-01', $h), 'before start');
            $e9 = $route($p, 8); // Tue, ended 2026-11-01
            T::eq('scheduled', Schedule::routeBaseStatus($e9, '2026-10-27', $h));
            T::eq(null, Schedule::routeBaseStatus($e9, '2026-11-03', $h), 'after end');
        },
        'R7 PH auto-pause: a regular route on a Mon-Sat PH is holiday_skipped' => function () use ($plan, $route) {
            $p = $plan();
            $occ = Schedule::routeOccurrence($p, $route($p, 5), '2026-12-25');
            T::subset(['key' => 'r5@2026-12-25', 'status' => 'holiday_skipped', 'type' => 'regular', 'recurring' => true, 'days' => [1, 3, 5]], $occ);
            T::eq('holiday_skipped', Schedule::routeOccurrence($p, $route($p, 5), '2026-11-09')['status'], 'Mon PH');
            // a cancelled override does not turn a paused date into "cancelled"
            $p2 = $plan(['route_overrides' => [['route_id' => 5, 'date' => '2026-12-25', 'cancelled' => true, 'stops' => null, 'note' => '']]]);
            T::eq('holiday_skipped', Schedule::routeOccurrence($p2, $route($p2, 5), '2026-12-25')['status']);
        },
        'R7 special: every Sunday and every PH, generated once when a Sunday is a PH' => function () use ($plan, $route, $keys) {
            $p = $plan();
            $h = Dates::holidayMap($p);
            $s1 = $route($p, 7); // sun + ph from 2026-11-15
            T::eq('scheduled', Schedule::routeBaseStatus($s1, '2026-11-15', $h), 'Sun');
            T::eq('scheduled', Schedule::routeBaseStatus($s1, '2026-12-25', $h), 'Fri PH');
            T::eq(null, Schedule::routeBaseStatus($s1, '2026-11-16', $h), 'Mon');
            T::eq(null, Schedule::routeBaseStatus($s1, '2026-11-08', $h), 'before start');
            T::eq(['r7@2026-11-29', 'r44@2026-11-29'], $keys(Schedule::routesOn($p, '2026-11-29')), 'Sunday PH: S1 once (+ one-off S2)');
            $sunOnly = ['sun' => true, 'ph' => false] + $s1;
            T::eq(null, Schedule::routeBaseStatus($sunOnly, '2026-12-25', $h), 'sun-only skips a weekday PH');
            $phOnly = ['sun' => false, 'ph' => true] + $s1;
            T::eq(null, Schedule::routeBaseStatus($phOnly, '2026-11-22', $h), 'ph-only skips a plain Sunday');
            T::eq('scheduled', Schedule::routeBaseStatus($phOnly, '2026-11-29', $h), 'ph-only on a Sunday PH');
        },
        'R7 one-off: exactly its own date' => function () use ($plan, $keys) {
            $p = $plan();
            T::eq(['r41@2026-11-12'], $keys(Schedule::routesOn($p, '2026-11-12')));
            T::eq(['r42@2026-12-25', 'r7@2026-12-25', 'r5@2026-12-25'], $keys(Schedule::routesOn($p, '2026-12-25')),
                'N1-25 and S1 by code, then the paused N1 last');
        },
        'R7/R9 overrides: cancelled, note and stops; edited badge' => function () use ($plan, $route) {
            $p = $plan(['route_overrides' => [
                ['route_id' => 5, 'date' => '2026-11-13', 'cancelled' => true, 'stops' => null, 'note' => 'closed'],
                ['route_id' => 5, 'date' => '2026-11-18', 'cancelled' => false, 'stops' => [['customer_id' => 40, 'note' => 'x']], 'note' => ''],
                ['route_id' => 5, 'date' => '2026-11-19', 'cancelled' => true, 'stops' => null, 'note' => 'not a run date'],
            ]]);
            $n1 = $route($p, 5);
            T::subset(['status' => 'cancelled', 'edited' => true, 'note' => 'closed', 'occurrence_note' => 'closed', 'route_note' => '',
                'stops' => [['seq' => 1, 'customer_id' => 12, 'note' => '3 bins'], ['seq' => 2, 'customer_id' => 40]]],
                Schedule::routeOccurrence($p, $n1, '2026-11-13'));
            T::subset(['status' => 'scheduled', 'edited' => true, 'stops' => [['seq' => 1, 'customer_id' => 40, 'note' => 'x']]],
                Schedule::routeOccurrence($p, $n1, '2026-11-18'));
            T::subset(['status' => 'scheduled', 'edited' => false, 'note' => ''], Schedule::routeOccurrence($p, $n1, '2026-11-16'));
            T::eq(null, Schedule::routeOccurrence($p, $n1, '2026-11-19'), 'an override on a date the route does not generate is ignored');
        },
        'R8 effective stops drop inactive customers and customers without the route\'s waste type' => function () use ($plan, $route) {
            $p = $plan();
            foreach ($p['routes'] as $k => $r) {
                if ($r['id'] === 5) {
                    $p['routes'][$k]['stops'] = [['customer_id' => 50, 'note' => ''], ['customer_id' => 12, 'note' => 'a'],
                        ['customer_id' => 60, 'note' => ''], ['customer_id' => 999, 'note' => ''], ['customer_id' => 40, 'note' => 'b']];
                }
            }
            T::eq([['customer_id' => 12, 'note' => 'a'], ['customer_id' => 40, 'note' => 'b']], Schedule::effectiveStops($p, $route($p, 5), '2026-11-16'));
            // a customer that lost the route's type (12 is OTC only now) is dropped
            foreach ($p['customers'] as $k => $cu) {
                if ($cu['id'] === 12) {
                    $p['customers'][$k]['waste_types'] = ['OTC', 'RECYCLING'];
                }
            }
            T::eq([['customer_id' => 40, 'note' => 'b']], Schedule::effectiveStops($p, $route($p, 5), '2026-11-16'));
            // the same list on a RECYCLING route keeps only the customer registered with RECYCLING
            $rcy = ['waste_type' => 'RECYCLING'] + $route($p, 5);
            T::eq([['customer_id' => 12, 'note' => 'a']], Schedule::effectiveStops($p, $rcy, '2026-11-16'));
            T::eq('RECYCLING', Schedule::routeOccurrence($p, $rcy, '2026-11-16')['waste_type']);
            T::eq('REL', Schedule::routeOccurrence($p, $route($p, 5), '2026-11-16')['waste_type'], 'a route stored without a type is a REL route');
        },
        'R8 stop weekdays: a stop with days is due only on them; an override and the snapshot hold plain lists' => function () use ($plan, $route) {
            $p = $plan(['route_overrides' => []]);
            foreach ($p['routes'] as $k => $r) {
                if ($r['id'] === 5) { // N1 Mon Wed Fri
                    $p['routes'][$k]['stops'] = [['customer_id' => 12, 'note' => '3 bins', 'days' => [1]], ['customer_id' => 40, 'note' => ''],
                        ['customer_id' => 21, 'note' => 'x', 'days' => [3, 5]]];
                }
            }
            $n1 = $route($p, 5);
            T::eq([['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']], Schedule::effectiveStops($p, $n1, '2026-11-16'), 'Mon');
            $wedFri = [['customer_id' => 40, 'note' => ''], ['customer_id' => 21, 'note' => 'x']];
            T::eq($wedFri, Schedule::effectiveStops($p, $n1, '2026-11-18'), 'Wed');
            T::eq($wedFri, Schedule::effectiveStops($p, $n1, '2026-11-20'), 'Fri');
            // an override is returned as it is, including a customer not due that weekday
            $p['route_overrides'] = [['route_id' => 5, 'date' => '2026-11-16', 'cancelled' => false, 'stops' => [['customer_id' => 21, 'note' => ''], ['customer_id' => 40, 'note' => '']], 'note' => '']];
            T::eq([['customer_id' => 21, 'note' => ''], ['customer_id' => 40, 'note' => '']], Schedule::effectiveStops($p, $n1, '2026-11-16'));
            $p['route_overrides'] = [];
            $snap = array_values(array_filter(Schedule::snapshot($p, '2026-11-16'), static fn ($e) => $e['key'] === 'r5@2026-11-16'));
            T::eq([['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']], $snap[0]['stops'], 'Monday only, no days key');
        },
        '§5.8 order: adhoc first, codes in natural order, paused last' => function () use ($plan, $keys) {
            $mk = static fn (int $id, string $code, string $type, array $x) => $x + ['id' => $id, 'code' => $code, 'color' => 1, 'type' => $type,
                'name' => $code, 'note' => '', 'rev' => 1, 'stops' => []];
            $p = $plan(['routes' => [
                $mk(1, 'N10', 'regular', ['start' => '2026-11-01', 'end' => null, 'days' => [5]]),
                $mk(2, 'N2', 'regular', ['start' => '2026-11-01', 'end' => null, 'days' => [5]]),
                $mk(3, 'B1', 'special', ['date' => '2026-12-25', 'copied_from' => null]),
                $mk(4, 'A1', 'regular', ['start' => '2026-11-01', 'end' => null, 'days' => [5]]),
            ], 'route_overrides' => [], 'tasks' => [
                ['id' => 1, 'waste_type' => 'COMPACTOR', 'customer_id' => 12, 'note' => '', 'rev' => 1, 'date' => '2026-11-13', 'copied_from' => null],
                ['id' => 2, 'waste_type' => 'OTC', 'customer_id' => 50, 'note' => '', 'rev' => 1, 'date' => '2026-11-13', 'copied_from' => null],
                ['id' => 3, 'waste_type' => 'OTC', 'customer_id' => 12, 'note' => '', 'rev' => 1, 'date' => '2026-11-13', 'copied_from' => null],
            ], 'task_overrides' => []]);
            T::eq(['r4@2026-11-13', 'r2@2026-11-13', 'r1@2026-11-13'], $keys(Schedule::routesOn($p, '2026-11-13')));
            T::eq(['r3@2026-12-25', 'r4@2026-12-25', 'r2@2026-12-25', 'r1@2026-12-25'], $keys(Schedule::routesOn($p, '2026-12-25')),
                'the PH one-off, then the paused regulars');
            $p['routes'][] = $mk(5, 'Z9', 'adhoc', ['date' => '2026-11-13', 'copied_from' => null]);
            T::eq('r5@2026-11-13', $keys(Schedule::routesOn($p, '2026-11-13'))[0], 'adhoc first');
        },
        'R13 snapshot: the routes of a date with identity, waste type, statuses and plain stops; no tasks' => function () use ($plan) {
            $p = $plan(['route_overrides' => [['route_id' => 5, 'date' => '2026-11-13', 'cancelled' => true, 'stops' => null, 'note' => 'skip']]]);
            $snap = Schedule::snapshot($p, '2026-11-13');
            T::subset([
                ['key' => 'r5@2026-11-13', 'kind' => 'route', 'route_id' => 5, 'code' => 'N1', 'color' => 1, 'type' => 'regular', 'waste_type' => 'REL', 'name' => 'North 1',
                    'status' => 'cancelled', 'edited' => true, 'recurring' => true, 'days' => [1, 3, 5], 'sun' => null, 'ph' => null,
                    'copied_from' => null, 'stops' => [['customer_id' => 12, 'note' => '3 bins'], ['customer_id' => 40, 'note' => '']],
                    'rev' => ['$absent' => true], 'date' => ['$absent' => true]],
            ], $snap); // exactly one entry: task 3 (Tue/Fri) of the old task feature is not frozen
            T::eq(['customer_id' => 12, 'note' => '3 bins'], $snap[0]['stops'][0], 'no seq in the snapshot');
            T::subset([['key' => 'r5@2026-12-25', 'status' => 'holiday_skipped']], array_values(array_filter(Schedule::snapshot($p, '2026-12-25'),
                static fn ($e) => $e['key'] === 'r5@2026-12-25')));
        },
        'jobOccurrence / jobStopIds: frozen for past dates, live from today (R21)' => function () use ($plan) {
            $p = $plan();
            $frozenDay = ['date' => '2026-11-09', 'plan' => [['key' => 'r5@2026-11-09', 'kind' => 'route', 'route_id' => 5, 'code' => 'N1',
                'status' => 'scheduled', 'stops' => [['customer_id' => 21, 'note' => '']]]], 'runs' => [], 'dropped_runs' => []];
            T::eq([21], Schedule::jobStopIds($p, $frozenDay, '2026-11-09', 'r5', '2026-11-11'), 'past: the frozen list, not the live one');
            T::subset(['key' => 'r5@2026-11-09', 'date' => '2026-11-09'], Schedule::jobOccurrence($p, $frozenDay, '2026-11-09', 'r5', '2026-11-11'));
            T::eq([], Schedule::jobStopIds($p, null, '2026-11-09', 'r5', '2026-11-11'), 'past with no frozen plan');
            T::eq([12, 40], Schedule::jobStopIds($p, null, '2026-11-11', 'r5', '2026-11-11'));
            T::eq([12], Schedule::jobStopIds($p, null, '2026-11-18', 'r5', '2026-11-11'), 'override list');
            T::eq([], Schedule::jobStopIds($p, null, '2026-11-11', 't6', '2026-11-11'), 'an old task job has no stops');
            T::eq(null, Schedule::jobOccurrence($p, null, '2026-11-23', 't10', '2026-11-11'));
            $withTask = ['plan' => array_merge($frozenDay['plan'], [['key' => 't6@2026-11-09', 'kind' => 'task', 'task_id' => 6, 'customer_id' => 12]])] + $frozenDay;
            T::eq(null, Schedule::jobOccurrence($p, $withTask, '2026-11-09', 't6', '2026-11-11'), 'a frozen task entry is not a job');
            T::eq('REL', Schedule::jobOccurrence($p, $frozenDay, '2026-11-09', 'r5', '2026-11-11')['waste_type'], 'a frozen entry without a type is REL');
            T::eq(null, Schedule::jobOccurrence($p, null, '2026-11-12', 'r5', '2026-11-11'), 'not a run date');
            T::eq(null, Schedule::jobOccurrence($p, null, '2026-11-11', 'x5', '2026-11-11'));
        },
        'firstGenerated: any status counts (R12), searched from a date' => function () use ($plan, $route) {
            $p = $plan();
            $h = Dates::holidayMap($p);
            T::eq('2026-11-11', Schedule::firstGenerated($route($p, 5), '2026-11-11', $h));
            T::eq('2026-11-13', Schedule::firstGenerated($route($p, 5), '2026-11-12', $h));
            T::eq('2026-12-25', Schedule::firstGenerated($route($p, 5), '2026-12-25', $h), 'a paused date counts');
            T::eq('2026-11-15', Schedule::firstGenerated($route($p, 7), '2026-11-11', $h), 'before start');
            T::eq(null, Schedule::firstGenerated($route($p, 8), '2026-11-11', $h), 'ended');
        },
    ];
})();
