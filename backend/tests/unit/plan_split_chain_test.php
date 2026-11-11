<?php
// Split routes (R12 / R14, §6.5): a "following" save or a schedule change ends the route record at D - 1 and
// continues it as a new record from D. To the office it is still ONE route, so every operation on a live
// segment applies to the whole live chain from its date on: End route (K1, SPLIT-2/3), Change schedule
// (SPLIT-4/5), "this date and following" and the template editor (SPLIT-6). The segments are linked by an
// explicit `series` written by the split, so an unrelated route that reuses an ended code is not one of them
// (SPLIT-1). Payloads carry the route's real period (SPLIT-7/8); a customer archive lists it once (SPLIT-9).
// Basic fixture, today Wed 2026-11-11, no run today; 25 Dec and 1 Jan are holidays.
return (static function (): array {
    $now = '2026-11-11T10:00:00+08:00';
    $noRuns = ['2026-11-11' => ['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => []]];
    $env = static fn (array $given = []) => TestEnv::make($given['now'] ?? $now, ['fixture' => 'basic', 'days' => $noRuns] + $given);
    $stops = static fn (int ...$ids) => array_map(static fn ($id) => ['customer_id' => $id, 'note' => ''], $ids);
    $create = static function (TestEnv $e, string $code, string $start, array $days, array $cids, array $extra = []) use ($stops): int {
        $body = array_replace(['type' => 'regular', 'code' => $code, 'name' => "Route $code", 'start' => $start, 'days' => $days, 'stops' => $stops(...$cids)], $extra);
        return T::ok($e->call('POST', '/api/routes', $body, 'mei'), 201)['id'];
    };
    $route = static function (TestEnv $e, int $id): ?array {
        foreach ($e->doc('plan')['routes'] as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        return null;
    };
    $rev = static fn (TestEnv $e, int $id): int => $route($e, $id)['rev'];
    $patch = static fn (TestEnv $e, int $id, array $body) => $e->call('PATCH', "/api/routes/$id", ['rev' => $rev($e, $id)] + $body, 'mei');
    $cs = static fn (TestEnv $e, int $id, array $body) => $e->call('POST', "/api/routes/$id/change-schedule", ['rev' => $rev($e, $id)] + $body, 'mei');
    $put = static fn (TestEnv $e, int $id, string $date, array $body) => $e->call('PUT', "/api/routes/$id/dates/$date", ['rev' => $rev($e, $id)] + $body, 'mei');
    /** date => occurrence (scheduled only) of route code $code between $from and $to, read from the month views. */
    $occs = static function (TestEnv $e, string $code, string $from, string $to): array {
        $out = [];
        for ($m = substr($from, 0, 7) . '-01'; $m <= $to; $m = (new DateTimeImmutable($m))->modify('+1 month')->format('Y-m-d')) {
            foreach (T::ok($e->call('GET', '/api/calendar?view=month&anchor=' . $m, null, 'mei'))['routes'] as $o) {
                if ($o['code'] === $code && $o['date'] >= $from && $o['date'] <= $to && $o['status'] === 'scheduled') {
                    $out[$o['date']] = $o;
                }
            }
        }
        ksort($out);
        return $out;
    };
    $dates = static fn (TestEnv $e, string $code, string $from, string $to): array => array_keys($occs($e, $code, $from, $to));
    /** Work dates between $from and $to on the given weekdays (the fixture's holidays excluded). */
    $wd = static function (string $from, string $to, array $days): array {
        $out = [];
        for ($d = $from; $d <= $to; $d = Dates::addDays($d, 1)) {
            if (in_array(Dates::weekday($d), $days, true) && !in_array($d, ['2026-12-25', '2027-01-01'], true)) {
                $out[] = $d;
            }
        }
        return $out;
    };
    $ids = static fn (array $occ): array => array_column($occ['stops'], 'customer_id');

    return [
        'SPLIT-1: a new route that reuses the code of an ended route is not a segment of it' => function () use ($env, $create, $route, $patch, $dates, $wd) {
            $e = $env();
            $old = $create($e, 'R1', '2026-11-11', [1, 3, 5], [12], ['name' => 'Old R1 (Jurong)']);
            T::ok($patch($e, $old, ['end' => '2026-11-30'])); // End route from 1 Dec
            $new = $create($e, 'R1', '2026-12-01', [2, 4], [21], ['name' => 'New R1 (Tampines)', 'color' => 3]);
            T::eq($new, $route($e, $new)['series'], 'a created route starts its own series');
            T::ok($patch($e, $new, ['name' => 'Tampines East', 'color' => 5]));
            T::ok($patch($e, $new, ['days' => [2, 4, 6]]));
            T::subset(['name' => 'Old R1 (Jurong)', 'days' => [1, 3, 5], 'end' => '2026-11-30', 'rev' => 2], $route($e, $old), 'rename and weekdays stay on the new route');
            T::subset(['name' => 'Tampines East', 'color' => 5, 'days' => [2, 4, 6]], $route($e, $new));
            T::eq(204, $e->call('DELETE', "/api/routes/$new?rev=3", null, 'mei')['status']);
            T::eq('Old R1 (Jurong)', $route($e, $old)['name'], 'deleting the new route keeps the old one');
            T::eq($wd('2026-11-11', '2026-11-30', [1, 3, 5]), $dates($e, 'R1', '2026-11-11', '2027-01-31'), 'the old route still runs 11-30 Nov, today included');
            // the other way round: deleting the old route keeps the new one; End route on the old one does not end it
            $o3 = $create($e, 'R3', '2026-11-11', [1, 3, 5], [12]);
            T::ok($patch($e, $o3, ['end' => '2026-11-30']));
            $n3 = $create($e, 'R3', '2026-12-01', [2, 4], [21]);
            T::ok($patch($e, $o3, ['end' => '2026-11-20']));
            T::subset(['start' => '2026-12-01', 'end' => null, 'rev' => 1], $route($e, $n3));
            T::eq(204, $e->call('DELETE', "/api/routes/$o3?rev=3", null, 'mei')['status']);
            T::eq('2026-12-01', $route($e, $n3)['start']);
            // a route stored before `series` existed (fixture N1, id 5) is not linked to a new route either
            T::ok($patch($e, 5, ['end' => '2026-11-30']));
            $n1 = $create($e, 'N1', '2026-12-01', [2], [21]);
            T::ok($patch($e, $n1, ['name' => 'North 1 new']));
            T::subset(['name' => 'North 1', 'end' => '2026-11-30'], $route($e, 5));
        },
        'K1 / SPLIT-2 / SPLIT-UI-01: End route from D, opened from an earlier segment, ends the whole route' => function () use ($env, $create, $route, $patch, $cs, $put, $dates, $wd, $stops) {
            $e = $env();
            $a = $create($e, 'K1A', '2026-11-11', [1, 3, 5], [12]);
            $b = T::ok($cs($e, $a, ['from' => '2026-12-01', 'days' => [2, 4]]))['created']['id'];
            T::eq($a, $route($e, $b)['series'], 'the split writes the link');
            $r = T::ok($patch($e, $a, ['end' => '2026-11-19']));
            T::subset(['id' => $a, 'end' => '2026-11-19', 'route_start' => '2026-11-11', 'route_end' => '2026-11-19'], $r);
            T::eq(null, $route($e, $b), 'the later segment (it never ran) is removed');
            T::eq($wd('2026-11-11', '2026-11-19', [1, 3, 5]), $dates($e, 'K1A', '2026-11-11', '2027-03-31'));
            // EN1: End route from Wed 2 Dec, the split date itself, opened from the earlier segment (its end is 1 Dec)
            $c = $create($e, 'EN1', '2026-11-11', [1, 3, 5], [12, 40]);
            $d = T::ok($put($e, $c, '2026-12-02', ['scope' => 'following', 'stops' => $stops(40, 12)]))['route']['id'];
            T::subset(['end' => '2026-12-01'], $route($e, $c));
            T::ok($patch($e, $c, ['end' => '2026-12-01']));
            T::eq(null, $route($e, $d));
            T::eq([], $dates($e, 'EN1', '2026-12-02', '2027-01-31'), 'nothing runs from 2 Dec');
            T::eq('2026-11-30', array_slice($dates($e, 'EN1', '2026-11-11', '2026-12-31'), -1)[0]);
            // SPLIT-UI-01: split W2 at Fri 20 Nov, then End from Mon 16 Nov from the 18 Nov occurrence
            $w = $create($e, 'W2', '2026-11-11', [1, 3, 5], [12, 40]);
            T::ok($put($e, $w, '2026-11-20', ['scope' => 'following', 'stops' => $stops(40, 12)]));
            T::ok($patch($e, $w, ['end' => '2026-11-15']));
            T::eq(['2026-11-11', '2026-11-13'], $dates($e, 'W2', '2026-11-11', '2026-12-31'));
            T::eq(1, count(array_filter($e->doc('plan')['routes'], static fn ($x) => $x['code'] === 'W2')), 'one W2 record left, no gap');
        },
        'SPLIT-3 / SPLIT-UI-02: an end on the other side of the split boundary applies to the route' => function () use ($env, $create, $route, $patch, $cs, $dates, $wd) {
            $e = $env();
            $a = $create($e, 'K1B', '2026-11-11', [1, 3, 5], [12]);
            $b = T::ok($cs($e, $a, ['from' => '2026-12-01', 'days' => [2, 4]]))['created']['id'];
            // (b) End from Tue 15 Dec, opened from November: the December segment ends on 14 Dec
            T::ok($patch($e, $a, ['end' => '2026-12-14']));
            T::subset(['end' => '2026-11-30'], $route($e, $a), 'the split boundary stays');
            T::subset(['start' => '2026-12-01', 'end' => '2026-12-14'], $route($e, $b));
            T::eq(array_merge($wd('2026-11-11', '2026-11-30', [1, 3, 5]), $wd('2026-12-01', '2026-12-14', [2, 4])), $dates($e, 'K1B', '2026-11-11', '2027-01-31'));
            // (d) the RouteForm opened from November shows the boundary as its end; clearing it removes the route's end
            T::ok($patch($e, $a, ['days' => [1, 3, 5], 'end' => null]));
            T::subset(['end' => '2026-11-30'], $route($e, $a));
            T::subset(['end' => null], $route($e, $b));
            // a real code conflict is still refused, naming the other route (not the route's own segment)
            T::ok($patch($e, $b, ['end' => '2026-12-31']));
            $other = $create($e, 'K1B', '2027-01-04', [1], [21]);
            $err = T::err($patch($e, $a, ['end' => null]), 422, 'CODE_IN_USE');
            T::eq($other, $err['details']['route']['id']);
            // (c) End from Wed 25 Nov opened from a December date: the November segment ends on 24 Nov
            T::ok($patch($e, $b, ['end' => '2026-11-24']));
            T::eq(null, $route($e, $b));
            T::subset(['end' => '2026-11-24'], $route($e, $a));
            T::eq($wd('2026-11-11', '2026-11-24', [1, 3, 5]), $dates($e, 'K1B', '2026-11-11', '2026-12-31'));
            // SPLIT-UI-02 B: End from Mon 16 Nov opened from Mon 23 Nov (the later segment)
            $k = $create($e, 'K1', '2026-11-11', [1, 3, 5], [12]);
            $k2 = T::ok($cs($e, $k, ['from' => '2026-11-20', 'days' => [1, 3, 5]]))['created']['id'];
            T::ok($patch($e, $k2, ['end' => '2026-11-15']));
            T::eq(['2026-11-11', '2026-11-13'], $dates($e, 'K1', '2026-11-11', '2026-12-31'));
            T::err($patch($e, $k, ['end' => '2026-11-01']), 422, 'PAST_DATE_LOCKED');
            // a start typed in Edit route opened from the later record is the route's first start
            $s = $create($e, 'ST1', '2026-11-16', [1, 3, 5], [12]);
            $s2 = T::ok($cs($e, $s, ['from' => '2026-11-30', 'days' => [2, 4]]))['created']['id'];
            T::subset(['id' => $s2, 'start' => '2026-11-30', 'route_start' => '2026-11-18'], T::ok($patch($e, $s2, ['start' => '2026-11-18'])));
            T::subset(['start' => '2026-11-18', 'end' => '2026-11-29'], $route($e, $s));
            T::subset(['field' => 'start'], T::err($patch($e, $s2, ['start' => '2026-12-02']), 422, 'VALIDATION'));
            // a form that shows the route's real start resends it with a rename: no change to any start
            T::ok($patch($e, $s2, ['start' => '2026-11-18', 'name' => 'ST1 renamed']));
            T::subset(['start' => '2026-11-30', 'name' => 'ST1 renamed'], $route($e, $s2));
            T::subset(['start' => '2026-11-18', 'name' => 'ST1 renamed'], $route($e, $s));
            // an ENDED part is history: moving its end into the later part says so, instead of CODE_IN_USE
            // naming the route's own record
            $dc = $create($e, 'DC1', '2026-11-11', [1, 3, 5], [12]);
            $dc2 = T::ok($cs($e, $dc, ['from' => '2026-11-23', 'days' => [2, 4]]))['created']['id'];
            $e->setNow('2026-12-02T10:00:00+08:00');
            T::subset(['field' => 'end'], T::err($patch($e, $dc, ['end' => '2026-12-10']), 422, 'VALIDATION'));
            T::subset(['start' => '2026-11-23', 'end' => null], $route($e, $dc2));
        },
        'SPLIT-4 / SPLIT-UI-07: Change schedule from D also changes the weekdays of the later segments' => function () use ($env, $create, $route, $put, $cs, $dates, $wd, $stops) {
            $e = $env();
            $a = $create($e, 'T2', '2026-11-11', [1, 3, 5], [12, 40]);
            T::ok($put($e, $a, '2026-11-20', ['scope' => 'this', 'cancelled' => true]));
            $b = T::ok($put($e, $a, '2026-12-02', ['scope' => 'following', 'stops' => $stops(40, 12)]))['route']['id'];
            $c = T::ok($cs($e, $b, ['from' => '2026-12-21', 'days' => [2, 4]]))['created']['id'];
            // Edit route from a November date, Apply from 25 Nov, Mon/Wed (End untouched, so the form does not send it)
            $r = T::ok($cs($e, $a, ['from' => '2026-11-25', 'days' => [1, 3]]));
            T::subset(['ended' => ['id' => $a, 'end' => '2026-11-24'], 'created' => ['start' => '2026-11-25', 'end' => '2026-12-01', 'days' => [1, 3],
                'route_start' => '2026-11-11', 'route_end' => null]], $r);
            T::subset(['days' => [1, 3], 'start' => '2026-12-02', 'end' => '2026-12-20'], $route($e, $b), 'Friday removed from the later segment');
            T::subset(['days' => [2, 4], 'start' => '2026-12-21'], $route($e, $c), 'the planned Tue/Thu schedule is kept');
            T::eq(array_merge($wd('2026-11-25', '2026-12-20', [1, 3]), $wd('2026-12-21', '2026-12-31', [2, 4])), $dates($e, 'T2', '2026-11-25', '2026-12-31'));
            // the clerk types the route's real end in the same request: it ends the whole route, from any segment
            $mid = $r['created']['id'];
            $x = T::ok($cs($e, $mid, ['from' => '2026-12-09', 'days' => [3], 'end' => '2027-01-31']));
            T::subset(['created' => ['start' => '2026-12-09', 'end' => '2026-12-20', 'days' => [3]]], $x);
            T::subset(['end' => '2026-12-08'], $route($e, $b));
            T::subset(['days' => [2, 4], 'end' => '2027-01-31'], $route($e, $c));
            T::eq([], $dates($e, 'T2', '2027-02-01', '2027-02-28'));
            // SPLIT-UI-07 A: E2 split at Fri 20 Nov; Fri removed from today; then Fri added again from Mon 16 Nov
            $e2 = $create($e, 'E2', '2026-11-11', [1, 3, 5], [12, 40]);
            $e2b = T::ok($put($e, $e2, '2026-11-20', ['scope' => 'following', 'stops' => $stops(40, 12)]))['route']['id'];
            T::ok($e->call('PATCH', "/api/routes/$e2", ['rev' => $route($e, $e2)['rev'], 'days' => [1, 3]], 'mei'));
            T::subset(['days' => [1, 3]], $route($e, $e2b));
            T::ok($cs($e, $e2, ['from' => '2026-11-16', 'days' => [1, 3, 5]]));
            T::subset(['days' => [1, 3, 5]], $route($e, $e2b));
            T::eq($wd('2026-11-16', '2026-12-06', [1, 3, 5]), $dates($e, 'E2', '2026-11-16', '2026-12-06'), 'Fri 20 and 27 Nov and 4 Dec run');
            // SPLIT-UI-07 B: C2 (Tue/Thu/Sat) split at Sat 21 Nov; Change schedule from the 11-20 Nov row, without Saturday
            $c2 = $create($e, 'C2', '2026-11-11', [2, 4, 6], [12, 40]);
            T::ok($put($e, $c2, '2026-11-21', ['scope' => 'following', 'stops' => $stops(40, 12)]));
            T::ok($cs($e, $c2, ['from' => '2026-11-24', 'days' => [2, 4]]));
            T::eq(array_merge($wd('2026-11-11', '2026-11-23', [2, 4, 6]), $wd('2026-11-24', '2026-12-12', [2, 4])), $dates($e, 'C2', '2026-11-11', '2026-12-12'));
            T::ok($cs($e, $c2, ['from' => '2026-11-17', 'days' => [2, 4]]));
            T::eq(array_merge($wd('2026-11-11', '2026-11-16', [2, 4, 6]), $wd('2026-11-17', '2026-12-12', [2, 4])), $dates($e, 'C2', '2026-11-11', '2026-12-12'),
                'no Saturday from 17 Nov: 21 and 28 Nov and 5 Dec');
            // an End the clerk types is applied even when it equals a split boundary (it used to be dropped as
            // "the end the form showed", while the toast said Saved): K3 split at Fri 20 Nov, from Mon 16 Nov
            // without Friday, End 19 Nov
            $k3 = $create($e, 'K3', '2026-11-11', [1, 3, 5], [12, 40]);
            T::ok($put($e, $k3, '2026-11-20', ['scope' => 'following', 'stops' => $stops(40, 12)]));
            T::subset(['end' => '2026-11-19'], $route($e, $k3));
            T::ok($cs($e, $k3, ['from' => '2026-11-16', 'days' => [1, 3], 'end' => '2026-11-19']));
            T::eq(array_merge($wd('2026-11-11', '2026-11-15', [1, 3, 5]), $wd('2026-11-16', '2026-11-19', [1, 3])), $dates($e, 'K3', '2026-11-11', '2027-01-31'),
                'the route ends on 19 Nov: nothing from 20 Nov');
            // an End equal to the route's current end is no change
            $k4 = $create($e, 'K4', '2026-11-11', [1, 3, 5], [12], ['end' => '2026-12-31']);
            T::ok($cs($e, $k4, ['from' => '2026-11-16', 'days' => [1], 'end' => '2026-12-31']));
            T::eq($wd('2026-11-16', '2026-12-31', [1]), $dates($e, 'K4', '2026-11-16', '2027-01-31'));
        },
        'SPLIT-5: Change schedule from a date in another segment, or from the split date itself' => function () use ($env, $create, $route, $put, $cs, $dates, $wd, $stops) {
            $e = $env();
            $a = $create($e, 'BD1', '2026-11-11', [1, 3, 5], [12, 40]);
            $b = T::ok($put($e, $a, '2026-12-02', ['scope' => 'following', 'stops' => $stops(40, 12)]))['route']['id'];
            $seq = $e->doc('plan')['seq']['route'];
            // (1) from the earlier segment, D = the split date: the later segment gets the new schedule, no new record
            $r = T::ok($cs($e, $a, ['from' => '2026-12-02', 'days' => [2, 4]]));
            T::subset(['ended' => ['id' => $a, 'end' => '2026-12-01'], 'created' => ['id' => $b, 'start' => '2026-12-02', 'days' => [2, 4], 'rev' => 2]], $r);
            T::eq($seq, $e->doc('plan')['seq']['route']);
            T::eq(array_merge($wd('2026-11-25', '2026-12-01', [1, 3, 5]), $wd('2026-12-02', '2026-12-31', [2, 4])), $dates($e, 'BD1', '2026-11-25', '2026-12-31'));
            // (2) from the later segment on its first day (the drawer on Wed 2 Dec)
            T::subset(['created' => ['id' => $b, 'days' => [1, 3, 5]]], T::ok($cs($e, $b, ['from' => '2026-12-02', 'days' => [1, 3, 5]])));
            // (3) from the earlier segment at 7 Dec, and from the later segment at 25 Nov
            $x = T::ok($cs($e, $a, ['from' => '2026-12-07', 'days' => [1]]));
            T::subset(['ended' => ['id' => $b, 'end' => '2026-12-06'], 'created' => ['start' => '2026-12-07', 'days' => [1]]], $x);
            T::subset(['end' => '2026-12-01'], $route($e, $a));
            $y = T::ok($cs($e, $b, ['from' => '2026-11-25', 'days' => [3]]));
            T::subset(['ended' => ['id' => $a, 'end' => '2026-11-24'], 'created' => ['start' => '2026-11-25', 'end' => '2026-12-01', 'days' => [3]]], $y);
            T::subset(['days' => [3]], $route($e, $b));
            T::eq(array_merge($wd('2026-11-11', '2026-11-24', [1, 3, 5]), $wd('2026-11-25', '2026-12-31', [3])),
                $dates($e, 'BD1', '2026-11-11', '2026-12-31'), 'Wed only from 25 Nov: Monday also leaves the Monday-only schedule from 7 Dec, which takes the new days');
            // still refused: today, before the route starts, after it ends
            T::err($cs($e, $b, ['from' => '2026-11-11', 'days' => [1]]), 422, 'VALIDATION');
            T::ok($e->call('PATCH', "/api/routes/$a", ['rev' => $route($e, $a)['rev'], 'end' => '2026-12-31'], 'mei'));
            T::subset(['field' => 'from'], T::err($cs($e, $a, ['from' => '2027-01-04', 'days' => [1]]), 422, 'VALIDATION'));
        },
        'SPLIT-6: "this date and following" and the template editor carry the change into the later segments' => function () use ($env, $create, $route, $put, $cs, $patch, $occs, $ids, $stops) {
            $e = $env();
            $a = $create($e, 'T5', '2026-11-11', [1, 3, 5], [12, 40]);
            $b = T::ok($put($e, $a, '2026-12-02', ['scope' => 'following', 'stops' => $stops(12, 40, 21)]))['route']['id'];
            $c = T::ok($cs($e, $b, ['from' => '2026-12-21', 'days' => [2, 4]]))['created']['id'];
            T::ok($put($e, $b, '2026-12-09', ['scope' => 'this', 'stops' => $stops(21)])); // own list on 9 Dec
            // (1) the drawer on Wed 11 Nov: customer 70 added, "and all following" (a template replace: today is the next date)
            T::ok($put($e, $a, '2026-11-11', ['scope' => 'following', 'stops' => $stops(12, 40, 70)]));
            T::eq([12, 40, 21, 70], array_column($route($e, $b)['stops'], 'customer_id'), 'the planned addition of 21 is kept, 70 added');
            T::eq([12, 40, 21, 70], array_column($route($e, $c)['stops'], 'customer_id'));
            $o = $occs($e, 'T5', '2026-11-11', '2026-12-31');
            T::eq([12, 40, 70], $ids($o['2026-11-13']));
            T::eq([12, 40, 21, 70], $ids($o['2026-12-02']));
            T::eq([21], $ids($o['2026-12-09']), 'a later date with its own list is not changed');
            T::eq([12, 40, 21, 70], $ids($o['2026-12-22']));
            // (2) the scope dialog names that date: GET /api/routes/{id} lists the overrides of the whole route
            T::subset(['overrides' => ['$contains' => [['route_id' => $b, 'date' => '2026-12-09', 'stops' => [['customer_id' => 21]]]]]],
                T::ok($e->call('GET', "/api/routes/$a", null, 'mei')));
            // (3) the drawer on 25 Nov, list = [70] only, "and all following": a split; 12 and 40 leave every later segment
            T::ok($put($e, $a, '2026-11-25', ['scope' => 'following', 'stops' => $stops(70)]));
            $o = $occs($e, 'T5', '2026-11-11', '2026-12-31');
            T::eq([12, 40, 70], $ids($o['2026-11-23']));
            T::eq([70], $ids($o['2026-11-27']));
            T::eq([21, 70], $ids($o['2026-12-02']));
            T::eq([21, 70], $ids($o['2026-12-22']));
            // (4) a reorder "and all following" reaches a later segment whose list was the same
            $d = $create($e, 'T6', '2026-11-11', [1, 3, 5], [12, 40, 21]);
            $d2 = T::ok($cs($e, $d, ['from' => '2026-12-07', 'days' => [1, 3]]))['created']['id'];
            T::ok($put($e, $d, '2026-11-20', ['scope' => 'following', 'stops' => $stops(40, 12, 21)]));
            T::eq([40, 12, 21], array_column($route($e, $d2)['stops'], 'customer_id'));
            // (5) the Routes-page template editor (PATCH stops, from today) also reaches the later segments
            T::ok($patch($e, $d, ['stops' => $stops(40, 21)]));
            foreach ($e->doc('plan')['routes'] as $x) {
                if ($x['code'] === 'T6') {
                    T::eq([40, 21], array_column($x['stops'], 'customer_id'), "T6 segment {$x['id']}");
                }
            }
        },
        'SPLIT-7 / SPLIT-8: route payloads carry the route as the office sees it (series, real period, next date)' => function () use ($env, $create, $put, $cs, $patch, $occs) {
            $e = $env();
            $a = $create($e, 'ND1', '2026-11-11', [3], [12]);
            T::ok($put($e, $a, '2026-11-11', ['scope' => 'this', 'cancelled' => true]));
            T::ok($put($e, $a, '2026-11-18', ['scope' => 'this', 'cancelled' => true]));
            $b = T::ok($cs($e, $a, ['from' => '2026-11-23', 'days' => [3]]))['created']['id'];
            $rows = array_values(array_filter(T::ok($e->call('GET', '/api/routes', null, 'mei')), static fn ($r) => $r['code'] === 'ND1'));
            T::subset([['id' => $a, 'series' => $a, 'start' => '2026-11-11', 'end' => '2026-11-22', 'next_date' => null,
                'route_start' => '2026-11-11', 'route_end' => null, 'route_next_date' => '2026-11-25'],
                ['id' => $b, 'series' => $a, 'start' => '2026-11-23', 'route_start' => '2026-11-11', 'route_end' => null, 'next_date' => '2026-11-25',
                    'route_next_date' => '2026-11-25']], $rows);
            T::subset(['id' => $b, 'start' => '2026-11-23', 'series' => $a, 'route_start' => '2026-11-11', 'route_end' => null],
                T::ok($e->call('GET', "/api/routes/$b", null, 'mei')));
            T::subset(['route_id' => $b, 'start' => '2026-11-23', 'end' => null, 'route_start' => '2026-11-11', 'route_end' => null],
                $occs($e, 'ND1', '2026-11-25', '2026-11-25')['2026-11-25']);
            T::subset(['route_start' => '2026-11-11', 'route_end' => '2026-12-31'], T::ok($patch($e, $a, ['end' => '2026-12-31'])));
            T::subset(['route_end' => '2026-12-31', 'end' => '2026-11-22'], T::ok($e->call('GET', "/api/routes/$a", null, 'mei')));
            // one-off routes are their own route
            T::subset(['series' => null, 'route_start' => null, 'route_end' => null], T::ok($e->call('GET', '/api/routes/41', null, 'mei')));
            // after the first segment has ended, the list still gives the route's real start
            $e->setNow('2026-12-02T10:00:00+08:00');
            $rows = array_values(array_filter(T::ok($e->call('GET', '/api/routes', null, 'mei')), static fn ($r) => $r['code'] === 'ND1'));
            T::subset([['id' => $b, 'route_start' => '2026-11-11', 'route_next_date' => '2026-12-02']], $rows);
        },
        'SPLIT-9: a customer archive lists a split route\'s template once' => function () use ($env, $create, $route, $put, $stops) {
            $e = $env();
            $a = $create($e, 'CU1', '2026-11-11', [1, 3, 5], [70, 21]);
            $b = T::ok($put($e, $a, '2026-12-02', ['scope' => 'following', 'stops' => $stops(21, 70)]))['route']['id'];
            T::ok($put($e, $b, '2026-12-09', ['scope' => 'this', 'stops' => $stops(70)]));
            T::subset(['routes' => [['route_id' => $a, 'code' => 'CU1']]], T::ok($e->call('GET', '/api/customers/70', null, 'mei')));
            $res = T::ok($e->call('POST', '/api/customers/70/archive', [], 'mei'));
            $routes = array_values(array_filter($res['removed'], static fn ($x) => $x['kind'] === 'route'));
            T::subset([['route_id' => $a, 'code' => 'CU1', 'where' => 'template', 'date' => null],
                ['route_id' => $b, 'code' => 'CU1', 'where' => 'override', 'date' => '2026-12-09']], $routes);
            T::eq([21], array_column($route($e, $a)['stops'], 'customer_id'));
            T::eq([21], array_column($route($e, $b)['stops'], 'customer_id'));
        },
        'a record stored without `series` is its own route: membership is never guessed from code and dates' => function () use ($env, $stops, $route, $dates, $wd) {
            // 46 ended 30 Nov and 47 starts 1 Dec with the same code: an "End route + new route" pair looks exactly
            // like a split, so without an explicit `series` they stay two routes.
            $fx = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/basic.json'), true);
            $routes = $fx['plan']['routes'];
            $routes[] = ['id' => 46, 'code' => 'L1', 'color' => 4, 'type' => 'regular', 'name' => 'Old L1', 'note' => '', 'rev' => 1,
                'start' => '2026-11-11', 'end' => '2026-11-30', 'days' => [1, 3, 5], 'stops' => $stops(12)];
            $routes[] = ['id' => 47, 'code' => 'L1', 'color' => 4, 'type' => 'regular', 'name' => 'New L1', 'note' => '', 'rev' => 1,
                'start' => '2026-12-01', 'end' => null, 'days' => [2, 4], 'stops' => $stops(21)];
            $e = $env(['plan' => ['routes' => $routes, 'seq' => ['customer' => 70, 'route' => 47, 'task' => 6]]]);
            T::subset(['series' => 47, 'route_start' => '2026-12-01', 'route_end' => null], T::ok($e->call('GET', '/api/routes/47', null, 'mei')));
            T::subset(['series' => 46, 'route_start' => '2026-11-11', 'route_end' => '2026-11-30'], T::ok($e->call('GET', '/api/routes/46', null, 'mei')));
            T::ok($e->call('PATCH', '/api/routes/47', ['rev' => 1, 'name' => 'Tampines', 'days' => [2, 4, 6]], 'mei'));
            T::subset(['name' => 'Old L1', 'days' => [1, 3, 5], 'rev' => 1], $route($e, 46), 'an edit of the new route leaves the old one alone');
            T::ok($e->call('PATCH', '/api/routes/46', ['rev' => 1, 'end' => '2026-11-19'], 'mei'));
            T::subset(['start' => '2026-12-01', 'end' => null], $route($e, 47), 'End on the old route does not touch the new one');
            // a split of a record without `series` links the new record to it from now on
            $r = T::ok($e->call('POST', '/api/routes/47/change-schedule', ['rev' => 2, 'from' => '2026-12-14', 'days' => [2]], 'mei'));
            T::eq([47, 47], [$route($e, 47)['series'], $route($e, $r['created']['id'])['series']]);
            T::eq(204, $e->call('DELETE', '/api/routes/47?rev=3', null, 'mei')['status']);
            T::eq(null, $route($e, $r['created']['id']), 'deleting the route removes both of its records');
            T::eq($wd('2026-11-11', '2026-11-19', [1, 3, 5]), $dates($e, 'L1', '2026-11-11', '2027-01-31'), 'the old route keeps running until its own end');
        },
    ];
})();
