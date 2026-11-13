<?php
// Per-stop collection weekdays (round 8): a stop of a regular recurring route's standing list may carry "days",
// a non-empty subset of the record's days. Absent = every day the route runs. The date's list (R8) holds only
// the stops due that weekday; overrides, one-offs, special routes, frozen days and runs never hold "days".
// Basic fixture: today Wed 2026-11-11; REL customers 12, 21, 40, 70; route 5 (N1) Mon Wed Fri with 12, 40.
// W1 below is route 45 (Mon Wed Fri from today unless said otherwise).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = []) => TestEnv::make($now, ['fixture' => 'basic', 'days' => $noRuns] + $given);
    $st = static fn (int $id, ?array $days = null, string $note = '') => ['customer_id' => $id, 'note' => $note] + ($days === null ? [] : ['days' => $days]);
    $route = static function (TestEnv $e, int $id): ?array {
        foreach ($e->doc('plan')['routes'] as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        return null;
    };
    $mk = static fn (TestEnv $e, array $stops, array $days = [1, 3, 5], string $start = '2026-11-11') => T::ok($e->call('POST', '/api/routes',
        ['type' => 'regular', 'waste_type' => 'REL', 'code' => 'W1', 'name' => 'West 1', 'start' => $start, 'days' => $days, 'stops' => $stops], 'mei'), 201);
    $occIds = static fn (TestEnv $e, string $key): array => array_column(RunsFx::occ($e, $key)['stops'], 'customer_id');
    $codes = static fn (array $res): array => array_column($res['json']['warnings'] ?? [], 'code');

    return [
        'create: stop days are stored sorted and unique, as sent; outputs carry them; stop_count is the standing list' => function () use ($env, $st, $route, $mk) {
            $e = $env();
            $r = $mk($e, [$st(12, [5, 1, 1]), $st(40, [1, 3, 5])]);
            $want = [$st(12, [1, 5]), $st(40, [1, 3, 5])];
            T::eq($want, $r['stops']);
            T::eq($want, $route($e, 45)['stops'], 'days equal to the route days are kept, key last');
            $g = T::ok($e->call('GET', '/api/routes/45', null, 'mei'));
            T::eq([$want, $want], [$g['stops'], $g['parts'][0]['stops']]);
            T::eq(2, array_column(T::ok($e->call('GET', '/api/routes', null, 'mei')), 'stop_count', 'code')['W1']);
        },

        'stop days must be weekdays of the record (WEEKDAY_NOT_ALLOWED); null is stored absent' => function () use ($env, $st, $route, $mk) {
            $e = $env();
            $base = ['type' => 'regular', 'waste_type' => 'REL', 'code' => 'W1', 'name' => 'West 1', 'start' => '2026-11-11', 'days' => [1, 3, 5]];
            foreach ([[], [2], [1, 2]] as $bad) {
                T::subset(['field' => 'stops.0.days'], T::err($e->call('POST', '/api/routes', $base + ['stops' => [$st(12, $bad)]], 'mei'), 422, 'WEEKDAY_NOT_ALLOWED'));
            }
            T::eq(44, $e->doc('plan')['seq']['route'], 'nothing was created');
            T::ok($e->call('POST', '/api/routes', $base + ['stops' => [['customer_id' => 12, 'note' => '', 'days' => null], $st(40, [3])]], 'mei'), 201);
            T::eq([$st(12), $st(40, [3])], $route($e, 45)['stops']);
            // PATCH: strict against the days the same request sets
            T::subset(['field' => 'stops.1.days'], T::err($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'days' => [1, 5], 'stops' => [$st(12), $st(40, [3])]], 'mei'), 422, 'WEEKDAY_NOT_ALLOWED'));
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 1, 'days' => [1, 5], 'stops' => [$st(12), $st(40, [5])]], 'mei'));
            T::eq([$st(12), $st(40, [5])], $route($e, 45)['stops']);
        },

        'stop days are refused on a special route, a one-off and an "only this date" list (VALIDATION)' => function () use ($env, $st) {
            $e = $env();
            $calls = [
                ['POST', '/api/routes', ['type' => 'special', 'waste_type' => 'REL', 'code' => 'S9', 'name' => 'x', 'start' => '2026-11-15', 'sun' => true, 'stops' => [$st(21, [1])]]],
                ['POST', '/api/routes', ['type' => 'adhoc', 'waste_type' => 'REL', 'code' => 'A9', 'name' => 'x', 'date' => '2026-11-12', 'stops' => [$st(21, [4])]]],
                ['PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 4, 'scope' => 'this', 'stops' => [$st(12, [5])]]],
                ['PUT', '/api/routes/5/dates/2026-11-13', ['rev' => 4, 'scope' => 'following', 'stops' => [$st(12, [5])]]],
                ['PUT', '/api/routes/41/dates/2026-11-12', ['rev' => 1, 'stops' => [$st(12, [4])]]],
            ];
            foreach ($calls as [$m, $path, $body]) {
                T::subset(['field' => 'stops.0.days'], T::err($e->call($m, $path, $body, 'mei'), 422, 'VALIDATION'), $path);
            }
            T::eq(json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true)['plan']['routes'], $e->doc('plan')['routes'], 'nothing was saved');
        },

        'no rewrite: an edit that does not touch the stops leaves the stored lists as they are' => function () use ($env, $st, $route, $mk) {
            $e = $env();
            $fx = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true)['plan']['routes'][0]['stops'];
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'name' => 'North one'], 'mei'));
            T::eq($fx, $route($e, 5)['stops'], 'no days key appears on a route that has none');
            $stops = [$st(12, [1, 5]), $st(40), $st(21, [3])];
            $mk($e, $stops);
            T::ok($e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-07', 'end' => '2027-06-30'], 'mei')); // 46 from 7 Dec, same days
            T::eq([2, 1], [$route($e, 45)['rev'], $route($e, 46)['rev']]);
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 2, 'name' => 'West one'], 'mei'));
            T::eq([$stops, $stops], [$route($e, 45)['stops'], $route($e, 46)['stops']]);
            T::eq(2, $route($e, 46)['rev'], 'the name reached the later part');
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 3, 'name' => 'West one'], 'mei'));
            T::eq([4, 2], [$route($e, 45)['rev'], $route($e, 46)['rev']], 'nothing to carry: the later part keeps its rev');
            T::eq($stops, $route($e, 46)['stops']);
        },

        'calendar: each date holds the stops due that weekday, numbered 1..n' => function () use ($env, $st, $mk) {
            $e = $env();
            $mk($e, [$st(12, [1], 'a'), $st(40), $st(21, [3, 5], 'b')]);
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-16', null, 'mei'));
            $got = [];
            foreach ($cal['routes'] as $o) {
                if ($o['route_id'] === 45) {
                    $got[$o['date']] = array_map(static fn ($s) => [$s['seq'], $s['customer_id'], $s['note'], array_key_exists('days', $s)], $o['stops']);
                }
            }
            T::eq([
                '2026-11-16' => [[1, 12, 'a', false], [2, 40, '', false]],
                '2026-11-18' => [[1, 40, '', false], [2, 21, 'b', false]],
                '2026-11-20' => [[1, 40, '', false], [2, 21, 'b', false]],
            ], $got);
        },

        'R9: an "only this date" list is dropped when it equals the list of its own weekday' => function () use ($env, $st, $route, $mk, $occIds) {
            $e = $env();
            $mk($e, [$st(12, [1]), $st(40), $st(21, [3, 5])]);
            $ovs = static fn () => array_values(array_filter($e->doc('plan')['route_overrides'], static fn ($o) => $o['route_id'] === 45));
            T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-16', ['rev' => 1, 'scope' => 'this', 'stops' => [$st(12), $st(40)]], 'mei'));
            T::eq([], $ovs(), "equal to Monday's list: no override");
            // the whole standing list on a Monday is a change: 21 is not due on Mondays
            $r = T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-16', ['rev' => 2, 'scope' => 'this', 'stops' => [$st(12), $st(40), $st(21)]], 'mei'));
            T::subset(['occurrence' => ['edited' => true]], $r);
            T::eq([[$st(12), $st(40), $st(21)]], array_column($ovs(), 'stops'));
            T::eq([12, 40, 21], $occIds($e, 'r45@2026-11-16'));
            // a later weekday edit that makes Monday's list equal to the override removes it
            T::ok($e->call('PATCH', '/api/routes/45', ['rev' => 3, 'stops' => [$st(12, [1]), $st(40), $st(21, [1, 3, 5])]], 'mei'));
            T::eq([], $ovs());
            T::eq([12, 40, 21], $occIds($e, 'r45@2026-11-16'));
        },

        'copy to date: the one-off gets the source date\'s stops and no weekdays' => function () use ($env, $st, $route, $mk) {
            $e = $env();
            $mk($e, [$st(12, [1], 'a'), $st(40), $st(21, [3, 5])]);
            $c = T::ok($e->call('POST', '/api/routes/45/dates/2026-11-16/copy', ['rev' => 1, 'to' => '2026-11-17'], 'mei'), 201);
            T::eq([$st(12, null, 'a'), $st(40)], $c['created']['stops']);
            T::eq([$st(12, null, 'a'), $st(40)], $route($e, $c['created']['id'])['stops']);
        },

        'a route weekday removed: stop days shrink, a stop left with none runs every day (STOP_DAYS_RESET); adding it back restores nothing' => function () use ($env, $st, $route, $mk, $codes) {
            $e = $env();
            $mk($e, [$st(12, [1, 5]), $st(40, [5]), $st(21)]);
            $res = $e->call('PATCH', '/api/routes/45', ['rev' => 1, 'days' => [1, 3]], 'mei');
            T::eq([$st(12, [1]), $st(40), $st(21)], T::ok($res)['stops']);
            T::eq(['STOP_DAYS_RESET'], $codes($res));
            T::eq([$st(12, [1]), $st(40), $st(21)], $route($e, 45)['stops'], '40 lost its only day: no key');
            $res = $e->call('PATCH', '/api/routes/45', ['rev' => 2, 'days' => [1, 3, 5]], 'mei');
            T::eq([$st(12, [1]), $st(40), $st(21)], T::ok($res)['stops'], '12 is not collected on Fridays again');
            T::eq([], $codes($res));
            // a removal that leaves every stop a day gives no warning
            $res = $e->call('PATCH', '/api/routes/45', ['rev' => 3, 'days' => [1, 5]], 'mei');
            T::eq([[$st(12, [1]), $st(40), $st(21)], []], [T::ok($res)['stops'], $codes($res)]);
            // the warning also comes when only a later part's stop is reset
            $e = $env();
            $mk($e, [$st(12, [1, 5]), $st(40)]);
            T::ok($e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-07', 'stops' => [$st(12, [5]), $st(40)]], 'mei')); // 46 from 7 Dec
            T::eq([$st(12, [1, 5]), $st(40)], $route($e, 45)['stops'], 'the part that runs now still has Mon Fri');
            $res = $e->call('PATCH', '/api/routes/45', ['rev' => $route($e, 45)['rev'], 'days' => [1, 3]], 'mei');
            T::ok($res);
            T::eq([[$st(12, [1]), $st(40)], [$st(12), $st(40)]], [$route($e, 45)['stops'], $route($e, 46)['stops']]);
            T::eq(['STOP_DAYS_RESET'], $codes($res));
        },

        'change-schedule: the record from D keeps the stop days that fit its weekdays; the ended record is untouched' => function () use ($env, $st, $route, $mk, $codes) {
            $stops = [$st(12, [1, 5]), $st(40, [3]), $st(21)];
            // a real split
            $e = $env();
            $mk($e, $stops);
            $res = $e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-07', 'days' => [2, 4]], 'mei');
            T::eq([$st(12), $st(40), $st(21)], T::ok($res)['created']['stops']);
            T::eq(['STOP_DAYS_RESET'], $codes($res));
            T::eq([$stops, [$st(12), $st(40), $st(21)]], [$route($e, 45)['stops'], $route($e, 46)['stops']]);
            // D is the first day of a later record: that record takes the schedule
            $e = $env();
            $mk($e, $stops);
            $res = $e->call('POST', '/api/routes/45/change-schedule', ['rev' => 1, 'from' => '2026-12-07'], 'mei');
            T::eq([[], $stops], [$codes($res), T::ok($res)['created']['stops']], 'the same weekdays: the copy has the same stop days');
            $res = $e->call('POST', '/api/routes/45/change-schedule', ['rev' => 2, 'from' => '2026-12-07', 'days' => [1, 2, 4]], 'mei');
            T::subset(['ended' => ['id' => 45, 'stops' => $stops], 'created' => ['id' => 46, 'days' => [1, 2, 4], 'stops' => [$st(12, [1]), $st(40), $st(21)]]], T::ok($res));
            T::eq(['STOP_DAYS_RESET'], $codes($res));
            T::eq([$stops, [$st(12, [1]), $st(40), $st(21)]], [$route($e, 45)['stops'], $route($e, 46)['stops']]);
            // sent stops are strict against the new weekdays
            T::subset(['field' => 'stops.0.days'], T::err($e->call('POST', '/api/routes/45/change-schedule',
                ['rev' => 2, 'from' => '2027-01-04', 'days' => [2, 4], 'stops' => [$st(12, [1])]], 'mei'), 422, 'WEEKDAY_NOT_ALLOWED'));
        },

        '"this date and following": the date\'s list is merged into the standing list (template replace and split)' => function () use ($env, $st, $route, $mk, $occIds) {
            // W1: 12 Mon, 40 every day, 21 Wed Fri. The Wednesday list is 40, 21.
            // 2026-11-11 is the next date (the template is replaced); 2026-11-18 splits the route.
            $run = static function (string $date, array $ids, ?array $thisFirst = null) use ($env, $st, $route, $mk, $occIds): array {
                $e = $env();
                $mk($e, [$st(12, [1]), $st(40), $st(21, [3, 5])]);
                $rev = 1;
                if ($thisFirst !== null) {
                    T::ok($e->call('PUT', "/api/routes/45/dates/$date", ['rev' => $rev++, 'scope' => 'this', 'stops' => array_map($st, $thisFirst)], 'mei'));
                }
                $r = T::ok($e->call('PUT', "/api/routes/45/dates/$date", ['rev' => $rev, 'scope' => 'following', 'stops' => array_map($st, $ids)], 'mei'));
                T::eq($date === '2026-11-11' ? 45 : 46, $r['route']['id'], $date);
                T::eq($ids, array_column($r['occurrence']['stops'], 'customer_id'), "the list of $date is the saved one");
                T::eq(false, $r['occurrence']['edited'], 'no override is left');
                if ($r['route']['id'] === 46) {
                    T::eq([$st(12, [1]), $st(40), $st(21, [3, 5])], $route($e, 45)['stops'], 'the ended record is untouched');
                }
                T::eq($r['route']['stops'], $route($e, $r['route']['id'])['stops']);
                return [$e, $route($e, $r['route']['id'])['stops']];
            };
            foreach (['2026-11-11', '2026-11-18'] as $d) {
                [, $got] = $run($d, [21, 40, 70]);
                T::eq([$st(12, [1]), $st(21, [3, 5]), $st(40), $st(70)], $got, "$d: reordered in their slots, 70 added for every day");
                [, $got] = $run($d, [40]);
                T::eq([$st(12, [1]), $st(40), $st(21, [5])], $got, "$d: 21 loses Wednesday only");
                [, $got] = $run($d, [21]);
                T::eq([$st(12, [1]), $st(21, [3, 5])], $got, "$d: 40 has no days of its own and leaves the route");
                [$e, $got] = $run($d, [40, 21, 12]);
                T::eq([$st(40), $st(21, [3, 5]), $st(12, [1, 3])], $got, "$d: 12 gains Wednesday and takes its new place");
                T::eq([40, 12], $occIds($e, 'r' . ($d === '2026-11-11' ? 45 : 46) . '@2026-11-23'), 'on Mondays too');
                // the date already had its own list without 21: a reorder saved as "following" still takes Wednesday from 21
                [$e, $got] = $run($d, [70, 40], [40, 70]);
                T::eq([$st(12, [1]), $st(70), $st(40), $st(21, [5])], $got, "$d: after an only-this-date list");
                T::eq([70, 40, 21], $occIds($e, 'r' . ($d === '2026-11-11' ? 45 : 46) . '@2026-11-20'), 'Friday keeps 21');
            }
            // a stop whose only day is that weekday leaves the route when removed
            $e = $env();
            $mk($e, [$st(12, [3]), $st(40)]);
            T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-11', ['rev' => 1, 'scope' => 'following', 'stops' => [$st(40)]], 'mei'));
            T::eq([$st(40)], $route($e, 45)['stops']);
            // a route without stop days: the saved list is stored as it is
            T::ok($e->call('PUT', '/api/routes/45/dates/2026-11-11', ['rev' => 2, 'scope' => 'following', 'stops' => [$st(21, null, 'x'), $st(40)]], 'mei'));
            T::eq([$st(21, null, 'x'), $st(40)], $route($e, 45)['stops']);
        },

        'downstream: totals, the driver\'s pending count, NOT_ON_JOB / OFF_PLAN and close-out use the stops due today' => function () use ($now, $st) {
            // route 5 is held by Ali today (Wed) with customer 12 collected; from now on only 40 is due on Wednesdays
            $mkEnv = static function () use ($now, $st): TestEnv {
                $e = TestEnv::make($now, ['fixture' => 'basic']);
                T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'stops' => [$st(12, [1]), $st(40, [3]), $st(21, [1, 5])]], 'mei'));
                return $e;
            };
            $e = $mkEnv();
            $occ = RunsFx::occ($e, 'r5@2026-11-11');
            T::eq([40], array_column($occ['stops'], 'customer_id'));
            T::subset(['pending' => 1, 'total' => 2], $occ['run']);
            T::eq([12], array_column($occ['off_plan'], 'customer_id'), 'the visit of 12 stays counted, off plan');
            T::eq([], $e->doc('day:2026-11-11')['runs']['r5']['removed'], '12 was visited: not "removed"');
            T::subset(['my_route' => ['job' => 'r5', 'pending' => 1, 'total' => 2]], T::ok($e->call('GET', '/api/driver/today', null, 'ali')));
            $ali = array_values(array_filter(T::ok($e->call('GET', '/api/drivers', null, 'mei')), static fn ($d) => $d['id'] === 3))[0];
            T::subset(['route_job' => ['job' => 'r5', 'pending' => 1]], $ali);
            T::eq([40], array_map(static fn ($s) => $s['customer']['id'], array_values(array_filter(
                T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'))['stops'], static fn ($s) => $s['on_plan']))));
            // 21 is on the route, but not on Wednesdays
            T::err(RunsFx::put($e, 'r5', 21, RunsFx::body(1, 0), 'ali'), 422, 'NOT_ON_JOB');
            T::ok($e->call('POST', '/api/runs/2026-11-11/r5/release', ['mark_missed' => true], 'mei'));
            $visits = $e->doc('day:2026-11-11')['runs']['r5']['visits'];
            T::eq([12, 40], array_keys($visits), 'no visit for 21');
            T::subset(['outcome' => 'missed', 'reason' => 'not_visited'], $visits['40']);
            T::eq('collected', $visits['12']['outcome']);
            // the office may record it as an off-plan visit
            $e = $mkEnv();
            $r = RunsFx::put($e, 'r5', 21, RunsFx::body(2, 0), 'mei', RunsFx::WED, true);
            T::subset(['visit' => ['flags' => ['OFF_PLAN']]], T::ok($r));
            T::eq(['OFF_PLAN'], array_column($r['json']['warnings'], 'code'));
        },

        'R26: today\'s weekday taken from a pending stop of a held run puts it in run.removed' => function () use ($now, $st) {
            $e = TestEnv::make($now, ['fixture' => 'basic']);
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'stops' => [$st(12, null, '3 bins'), $st(40, [1])]], 'mei'));
            T::eq([40], $e->doc('day:2026-11-11')['runs']['r5']['removed']);
            T::eq([12], array_column(RunsFx::occ($e, 'r5@2026-11-11')['stops'], 'customer_id'));
        },

        'a route date with no stop due still has an occurrence; the frozen day holds that date\'s stops and no weekdays' => function () use ($env, $st, $route, $mk) {
            $e = $env();
            $mk($e, [$st(12, [1])]); // W1 runs today (Wed), its only customer on Mondays
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 4, 'stops' => [$st(12, [1]), $st(40, [3]), $st(21, [1, 5])]], 'mei'));
            T::subset(['status' => 'scheduled', 'stops' => []], RunsFx::occ($e, 'r45@2026-11-11'));
            T::eq(['r5'], array_column(T::ok($e->call('GET', '/api/driver/today', null, 'bala'))['routes'], 'job'), 'nothing to do on W1 today');
            T::err(RunsFx::claim($e, 'r45', 'bala'), 422, 'NOT_RUNNABLE');
            $e->setNow('2026-11-12T10:00:00+08:00'); // the first request freezes Wednesday
            T::ok($e->call('GET', '/api/calendar', null, 'mei'));
            $frozen = array_column($e->doc('day:2026-11-11')['plan'], 'stops', 'key');
            T::eq(['r5@2026-11-11' => [$st(40)], 'r45@2026-11-11' => []], $frozen);
            T::ok($e->call('PATCH', '/api/routes/5', ['rev' => 5, 'stops' => [$st(21), $st(12, [3])]], 'mei'));
            T::eq($frozen, array_column($e->doc('day:2026-11-11')['plan'], 'stops', 'key'), 'a later edit leaves the frozen day as it is');
            T::eq([40], array_column(RunsFx::occ($e, 'r5@2026-11-11')['stops'], 'customer_id'));
        },
    ];
})();
