<?php
// Result writes R27-R31 (§10.8, §10.9): content, weighable types, tickets, files, the R30 revision matrix,
// the edit window, LATE, NOT_ON_JOB / OFF_PLAN, office why / back-fill, undo, same customer on two jobs.
// Setup: tests/runs_lib.php (today Wed 2026-11-11).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $held = static fn (array $visits = [], array $removed = []) => ['r5' => RunsFx::run('r5', 3, $visits, null, $removed), 't6' => RunsFx::run('t6', 3)];
    $put = [RunsFx::class, 'put'];
    $b = [RunsFx::class, 'body'];

    return [
        'a collected stop: "," decimal, photo + signature, snapshot, progress and totals' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held([RunsFx::visit(12, 'collected', ['REL' => 120.5])])]);
            $photo = RunsFx::op(501) . '.jpg';
            $sig = RunsFx::op(502) . '.png';
            T::ok(RunsFx::upload($e, $photo, RunsFx::jpeg()), 201);
            T::ok(RunsFx::upload($e, $sig, RunsFx::png()), 201);
            $r = $put($e, 'r5', 40, $b(1, 0, 'collected', ['weights' => ['REL' => '80,5'], 'photos' => [$photo], 'signature' => $sig,
                'note' => 'ok', 'captured_at' => '2026-11-11T09:59:00+08:00']), 'ali');
            $d = T::ok($r);
            T::eq([], $r['json']['warnings']);
            T::subset(['replay' => false, 'progress' => ['collected' => 2, 'missed' => 0, 'pending' => 0, 'total' => 2], 'totals' => ['REL' => 201.0],
                'visit' => ['customer_id' => 40, 'outcome' => 'collected', 'weights' => ['REL' => 80.5], 'tickets' => [], 'reason' => null, 'note' => 'ok',
                    'photos' => ['files/00/' . $photo], 'signature' => 'files/00/' . $sig, 'driver_id' => 3, 'by' => 'user:3', 'rev' => 1, 'flags' => [],
                    'customer' => ['code' => 'C0040', 'name' => 'Golden Bakery', 'address' => '5 Tuas South Ave 2'],
                    'captured_at' => '2026-11-11T09:59:00+08:00', 'received_at' => '2026-11-11T10:00:00+08:00', 'ops' => ['$absent' => true], 'history' => ['$absent' => true]]], $d);
            T::true(str_contains($r['response']->body, '"tickets":{}'), 'empty tickets encode as {}');
            T::subset(['rev' => 1, 'ops' => [['op_id' => RunsFx::op(1), 'result' => 'applied']], 'history' => []], RunsFx::diskRun($e, 'r5')['visits']['40']);
            T::subset(['run_status' => 'done', 'run' => ['totals' => ['REL' => 201.0], 'flagged' => 0]], RunsFx::occ($e, 'r5@2026-11-11'));
            // an integer weight and the max value are fine
            T::ok($put($e, 't6', 12, $b(2, 0, 'collected', ['weights' => ['OTC' => 99999.9]]), 'ali'));
            T::eq(99999.9, RunsFx::diskRun($e, 't6')['visits']['12']['weights']['OTC']);
        },

        'weighable types: OTC/COMPACTOR refused on a route, REL refused on a task (TYPE_NOT_ALLOWED)' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            T::subset(['field' => 'weights.COMPACTOR', 'details' => ['allowed' => ['REL']]],
                T::err($put($e, 'r5', 40, $b(1, 0, 'collected', ['weights' => ['REL' => 5, 'COMPACTOR' => 5]]), 'ali'), 422, 'TYPE_NOT_ALLOWED'));
            T::err($put($e, 'r5', 12, $b(2, 0, 'collected', ['weights' => ['OTC' => 5]]), 'ali'), 422, 'TYPE_NOT_ALLOWED');
            T::err($put($e, 'r5', 12, $b(3, 0, 'collected', ['weights' => ['GLS' => 5]]), 'ali'), 422, 'TYPE_NOT_ALLOWED');
            T::subset(['field' => 'weights.REL', 'details' => ['allowed' => ['OTC']]],
                T::err($put($e, 't6', 12, $b(4, 0, 'collected', ['weights' => ['REL' => 5]]), 'ali'), 422, 'TYPE_NOT_ALLOWED'));
            T::err($put($e, 't6', 12, $b(5, 0, 'collected', ['weights' => ['OTC' => 5], 'tickets' => ['REL' => 'X']]), 'ali'), 422, 'TYPE_NOT_ALLOWED');
            T::ok($put($e, 't6', 12, $b(6, 0, 'collected', ['weights' => ['OTC' => 5]]), 'ali'));
            T::err($put($e, 't6', 40, $b(7, 0, 'collected', ['weights' => ['OTC' => 5]]), 'ali'), 422, 'NOT_ON_JOB'); // a task has one customer
            T::err($put($e, 't6', 40, $b(8, 0, 'collected', ['weights' => ['OTC' => 5]]), 'mei', RunsFx::WED, true), 422, 'NOT_ON_JOB'); // office too
            // the stop's weigh_types in JobDetail match: REL only on the route, OTC only on the task
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::eq([['REL'], ['REL']], array_column($j['stops'], 'weigh_types'));
            T::eq([['OTC']], array_column(T::ok($e->call('GET', '/api/driver/runs/2026-11-11/t6', null, 'ali'))['stops'], 'weigh_types'));
        },

        'weights and reasons: WEIGHT_INVALID, WEIGHT_REQUIRED, missed needs a reason, "other" needs a note' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            foreach ([12.55, -1, 100000, '12,55', 'abc', '1e3', true, [1]] as $n => $bad) {
                T::subset(['field' => 'weights.REL'], T::err($put($e, 'r5', 40, $b(10 + $n, 0, 'collected', ['weights' => ['REL' => $bad]]), 'ali'), 422, 'WEIGHT_INVALID'));
            }
            T::err($put($e, 'r5', 40, $b(20, 0, 'collected', ['weights' => ['REL' => 0]]), 'ali'), 422, 'WEIGHT_REQUIRED');
            T::err($put($e, 'r5', 40, $b(21, 0, 'collected', ['weights' => []]), 'ali'), 422, 'WEIGHT_REQUIRED');
            T::err($put($e, 'r5', 40, $b(22, 0, 'collected', ['weights' => [5]]), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, $b(23, 0, 'done'), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, $b(24, 0, 'missed', ['reason' => null]), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, $b(25, 0, 'missed', ['reason' => 'lost']), 'ali'), 422, 'VALIDATION');
            T::subset(['field' => 'note'], T::err($put($e, 'r5', 40, $b(26, 0, 'missed', ['reason' => 'other', 'note' => '  ']), 'ali'), 422, 'REASON_REQUIRED'));
            T::err($put($e, 'r5', 40, $b(27, 0, 'missed', ['weights' => ['REL' => 5]]), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, $b(28, 0, 'collected', ['note' => str_repeat('x', 501)]), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, ['base_rev' => 0, 'outcome' => null], 'ali'), 422, 'VALIDATION'); // op_id required
            T::err($put($e, 'r5', 40, ['op_id' => 'not-a-uuid', 'base_rev' => 0, 'outcome' => null], 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, ['op_id' => RunsFx::op(29), 'outcome' => null], 'ali'), 422, 'VALIDATION'); // base_rev required
            T::err($put($e, 'r5', 40, $b(30, 0, 'collected', ['extra' => 1]), 'ali'), 422, 'VALIDATION');
            T::eq([], RunsFx::diskRun($e, 'r5')['visits'], 'no refused write was stored');
            // a missed stop with zero weights and the "other" reason with a note is fine
            $d = T::ok($put($e, 'r5', 40, $b(31, 0, 'missed', ['weights' => ['REL' => 0], 'reason' => 'other', 'note' => 'shutter down']), 'ali'));
            T::subset(['outcome' => 'missed', 'reason' => 'other', 'weights' => [], 'note' => 'shutter down'], $d['visit']);
        },

        'TICKET_REQUIRED only for weighbridge types; tickets are dropped for on-site types' => function () use ($held, $put, $b) {
            $plan = Seed::plan('2026-11-11', $GLOBALS['WMS_TEST_CONFIG']['seed_file']);
            $wt = $plan['waste_types'];
            $wt[0]['weigh_method'] = 'weighbridge'; // REL
            $e = RunsFx::env(['runs' => $held(), 'plan' => ['waste_types' => $wt]]);
            T::subset(['field' => 'tickets.REL'], T::err($put($e, 'r5', 40, $b(1, 0, 'collected', ['weights' => ['REL' => 10]]), 'ali'), 422, 'TICKET_REQUIRED'));
            T::err($put($e, 'r5', 40, $b(2, 0, 'collected', ['weights' => ['REL' => 10], 'tickets' => ['REL' => ' ']]), 'ali'), 422, 'TICKET_REQUIRED');
            T::err($put($e, 'r5', 40, $b(3, 0, 'collected', ['weights' => ['REL' => 10], 'tickets' => ['REL' => str_repeat('9', 31)]]), 'ali'), 422, 'VALIDATION');
            $d = T::ok($put($e, 'r5', 40, $b(4, 0, 'collected', ['weights' => ['REL' => 10], 'tickets' => ['REL' => 'WB-881']]), 'ali'));
            T::eq(['REL' => 'WB-881'], (array) $d['visit']['tickets']);
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::eq(['REL'], $j['stops'][0]['ticket_types']);
            // OTC is on-site: a ticket sent anyway is dropped, none is required
            $d = T::ok($put($e, 't6', 12, $b(5, 0, 'collected', ['weights' => ['OTC' => 10], 'tickets' => ['OTC' => 'T1']]), 'ali'));
            T::eq([], (array) $d['visit']['tickets']);
            T::eq([], T::ok($e->call('GET', '/api/driver/runs/2026-11-11/t6', null, 'ali'))['stops'][0]['ticket_types']);
        },

        'files: FILE_MISSING for a reference that was not uploaded; at most 5 photos; bad names' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            $f = RunsFx::op(601) . '.jpg';
            T::subset(['field' => 'photos.0', 'details' => ['file' => $f]], T::err($put($e, 'r5', 40, $b(1, 0, 'collected', ['photos' => [$f]]), 'ali'), 422, 'FILE_MISSING'));
            T::err($put($e, 'r5', 40, $b(2, 0, 'collected', ['signature' => RunsFx::op(602) . '.png']), 'ali'), 422, 'FILE_MISSING');
            T::err($put($e, 'r5', 40, $b(3, 0, 'collected', ['photos' => ['../../plan.json']]), 'ali'), 422, 'VALIDATION');
            T::err($put($e, 'r5', 40, $b(4, 0, 'collected', ['photos' => 'x.jpg']), 'ali'), 422, 'VALIDATION');
            $names = [];
            for ($i = 0; $i < 6; $i++) {
                $names[] = RunsFx::op(610 + $i) . '.jpg';
                T::ok(RunsFx::upload($e, $names[$i], RunsFx::jpeg((string) $i)), 201);
            }
            T::subset(['field' => 'photos'], T::err($put($e, 'r5', 40, $b(5, 0, 'collected', ['photos' => $names]), 'ali'), 422, 'VALIDATION'));
            // five photos, given as names or as stored paths (the office resends stored paths)
            $five = array_slice($names, 0, 5);
            $five[4] = 'files/00/' . $five[4];
            $d = T::ok($put($e, 'r5', 40, $b(6, 0, 'collected', ['photos' => $five]), 'ali'));
            T::eq(5, count($d['visit']['photos']));
            T::eq('files/00/' . $names[0], $d['visit']['photos'][0]);
        },

        'R30: replay by op_id, base_rev match, same principal, a conflict is kept in history with CONFLICT' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            T::eq(1, T::ok($put($e, 'r5', 40, $b(1, 0, 'collected', ['weights' => ['REL' => 10]]), 'ali'))['visit']['rev']);
            // 1. replay: the recorded result, nothing changes (even when the resent body differs)
            $d = T::ok($put($e, 'r5', 40, $b(1, 0, 'collected', ['weights' => ['REL' => 99]]), 'ali'));
            T::subset(['replay' => true, 'visit' => ['rev' => 1, 'weights' => ['REL' => 10.0]]], $d);
            // 2. base_rev = rev: applied, the previous version goes to history
            T::eq(2, T::ok($put($e, 'r5', 40, $b(2, 1, 'collected', ['weights' => ['REL' => 11]]), 'ali'))['visit']['rev']);
            // 3. a stale base_rev from the same principal (lost response, new edit): applied
            T::eq(3, T::ok($put($e, 'r5', 40, $b(3, 0, 'collected', ['weights' => ['REL' => 12]]), 'ali'))['visit']['rev']);
            $v = RunsFx::diskRun($e, 'r5')['visits']['40'];
            T::subset([['rev' => 1, 'op_id' => RunsFx::op(1), 'by' => 'user:3', 'weights' => ['REL' => 10.0], 'rejected' => false],
                ['rev' => 2, 'op_id' => RunsFx::op(2), 'weights' => ['REL' => 11.0], 'rejected' => false]], $v['history']);
            // 4. another principal with a stale base_rev: 409, the body is kept (rejected) and the visit is flagged
            $err = T::err($put($e, 'r5', 40, $b(4, 1, 'collected', ['weights' => ['REL' => 50], 'why' => 'recheck']), 'mei', RunsFx::WED, true), 409, 'VISIT_CHANGED');
            T::subset(['visit' => ['rev' => 3, 'weights' => ['REL' => 12.0], 'flags' => ['CONFLICT']]], $err['details']);
            $v = RunsFx::diskRun($e, 'r5')['visits']['40'];
            T::eq(3, $v['rev']);
            T::subset(['rev' => 3, 'by' => 'user:2', 'op_id' => RunsFx::op(4), 'base_rev' => 1, 'weights' => ['REL' => 50.0], 'why' => 'recheck', 'rejected' => true], end($v['history']));
            T::subset(['op_id' => RunsFx::op(4), 'result' => 'rejected'], end($v['ops']));
            // a replay of the rejected op gives the same 409 and changes nothing
            T::err($put($e, 'r5', 40, $b(4, 1, 'collected', ['weights' => ['REL' => 50], 'why' => 'recheck']), 'mei', RunsFx::WED, true), 409, 'VISIT_CHANGED');
            T::eq(count($v['history']), count(RunsFx::diskRun($e, 'r5')['visits']['40']['history']));
            // the office with the current rev and a reason: applied, OFFICE_EDITED, the driver credit is kept
            $d = T::ok($put($e, 'r5', 40, $b(5, 3, 'collected', ['weights' => ['REL' => 13], 'why' => 'weighbridge recheck', 'driver_id' => 4]), 'mei', RunsFx::WED, true));
            T::subset(['visit' => ['rev' => 4, 'by' => 'user:2', 'driver_id' => 3, 'why' => 'weighbridge recheck', 'flags' => ['CONFLICT', 'OFFICE_EDITED'],
                'history' => ['$len' => 4]], 'run' => ['collected' => 1, 'flagged' => 1]], $d);
            // R28: the driver can no longer change a visit the office wrote last, even with the current rev
            T::err($put($e, 'r5', 40, $b(6, 4, 'collected', ['weights' => ['REL' => 14]]), 'ali'), 409, 'VISIT_CHANGED');
            T::subset(['rev' => 4, 'weights' => ['REL' => 13.0]], RunsFx::diskRun($e, 'r5')['visits']['40']);
            // two drivers on one pending stop: the second (stale) write is a conflict, never an overwrite
            $f = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 4, [], [RunsFx::hold(3, '2026-11-11T07:00:00+08:00', 'SBA1234X', '2026-11-11T08:00:00+08:00', 'switched'), RunsFx::hold(4, '2026-11-11T08:10:00+08:00')])]]);
            T::ok($put($f, 'r5', 12, $b(7, 0, 'collected', ['weights' => ['REL' => 1]]), 'bala'));
            T::err($put($f, 'r5', 12, $b(8, 0, 'collected', ['weights' => ['REL' => 2]]), 'ali'), 409, 'VISIT_CHANGED');
            T::subset(['by' => 'user:4', 'weights' => ['REL' => 1.0], 'flags' => ['CONFLICT'], 'history' => [['by' => 'user:3', 'rejected' => true]]],
                RunsFx::diskRun($f, 'r5')['visits']['12']);
        },

        'edit window: a late first result is accepted (LATE); corrections until rollover + 8 h; rollover 2 moves it to 10:00' => function () use ($put, $b) {
            $runs = ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12)])];
            $e = RunsFx::env(['runs' => $runs]); // created on Wed, so the first Thursday request freezes Wed (R13)
            $e->setNow('2026-11-12T11:59:59+08:00');
            $d = $put($e, 'r5', 12, $b(1, 1, 'collected', ['weights' => ['REL' => 11]]), 'ali');
            T::eq(2, T::ok($d)['visit']['rev']);
            T::eq([['code' => 'LATE', 'message' => Http::message('LATE')]], $d['json']['warnings']);
            $e->setNow('2026-11-12T12:00:00+08:00');
            T::subset(['details' => ['deadline' => '2026-11-12T12:00:00+08:00']],
                T::err($put($e, 'r5', 12, $b(2, 2, 'collected', ['weights' => ['REL' => 12]]), 'ali'), 422, 'EDIT_WINDOW_CLOSED'));
            T::err($put($e, 'r5', 12, $b(3, 2, null), 'ali'), 422, 'EDIT_WINDOW_CLOSED'); // undo is a change too
            // a replay of the accepted 11:59:59 write is answered before the window check
            T::subset(['replay' => true, 'visit' => ['rev' => 2]], T::ok($put($e, 'r5', 12, $b(1, 1, 'collected', ['weights' => ['REL' => 11]]), 'ali')));
            // a first result for a pending stop is accepted at any time (LATE)
            $late = $put($e, 'r5', 40, $b(4, 0, 'collected'), 'ali');
            T::subset(['visit' => ['flags' => ['LATE']]], T::ok($late));
            T::eq('LATE', $late['json']['warnings'][0]['code']);
            T::ok($put($e, 'r5', 12, $b(5, 2, 'collected', ['weights' => ['REL' => 9], 'why' => 'office fix']), 'mei', RunsFx::WED, true)); // the office has no window
            // rollover 2: the deadline is 10:00
            $r2 = RunsFx::env(['runs' => $runs, 'plan' => ['settings' => ['rollover_hour' => 2]]]);
            $r2->setNow('2026-11-12T09:59:59+08:00');
            T::ok($put($r2, 'r5', 12, $b(6, 1, 'collected', ['weights' => ['REL' => 11]]), 'ali'));
            $r2->setNow('2026-11-12T10:00:00+08:00');
            T::err($put($r2, 'r5', 12, $b(7, 2, 'collected', ['weights' => ['REL' => 12]]), 'ali'), 422, 'EDIT_WINDOW_CLOSED');
        },

        'LATE effective time: captured_at counts only inside [hold.from, received_at]' => function () use ($put, $b) {
            $runs = ['r5' => RunsFx::run('r5', 3)];
            $e = RunsFx::env(['runs' => $runs]);
            $e->setNow('2026-11-12T04:05:00+08:00');
            $w = static fn (int $op, int $cid, ?string $cap) => $put($e, 'r5', $cid, $b($op, 0, 'collected', ['captured_at' => $cap]), 'ali');
            T::eq([], T::ok($w(1, 12, '2026-11-12T03:50:00+08:00'))['visit']['flags'], 'captured 03:50, received 04:05: not LATE');
            T::eq(['LATE'], T::ok($w(2, 40, '2026-11-12T04:01:00+08:00'))['visit']['flags'], 'captured 04:01: LATE');
            $f = RunsFx::env(['runs' => $runs]);
            $f->setNow('2026-11-12T04:05:00+08:00');
            $wf = static fn (int $op, int $cid, ?string $cap) => $put($f, 'r5', $cid, $b($op, 0, 'collected', ['captured_at' => $cap]), 'ali');
            T::eq(['LATE'], T::ok($wf(3, 12, '2026-11-11T07:00:00+08:00'))['visit']['flags'], 'captured before the hold started: received_at is used');
            T::eq(['LATE'], T::ok($wf(4, 40, null))['visit']['flags'], 'no captured_at: received_at is used');
            $g = RunsFx::env(['runs' => $runs]);
            $g->setNow('2026-11-12T03:55:00+08:00');
            T::subset(['flags' => [], 'captured_at' => '2026-11-12T05:00:00+08:00'],
                T::ok($put($g, 'r5', 12, $b(5, 0, 'collected', ['captured_at' => '2026-11-12T05:00:00+08:00']), 'ali'))['visit'],
                'captured after received_at: received_at (03:55) is used for LATE; the device time is still stored');
            T::subset(['flags' => [], 'captured_at' => null], T::ok($put($g, 'r5', 40, $b(6, 0, 'collected', ['captured_at' => 'yesterday']), 'ali'))['visit'],
                'an unparseable captured_at is stored as null');
            // a writer who is not run.driver_id is LATE even on time (R24: a late write after release is accepted)
            $h = RunsFx::env(['runs' => $runs]);
            T::ok($h->call('POST', '/api/runs/2026-11-11/r5/release', ['mark_missed' => false], 'mei'));
            $r = $put($h, 'r5', 40, $b(7, 0, 'collected', ['captured_at' => '2026-11-11T09:30:00+08:00']), 'ali');
            T::eq(['LATE'], T::ok($r)['visit']['flags']);
            T::eq('open', RunsFx::occ($h, 'r5@2026-11-11')['run_status']);
        },

        'NOT_HOLDER, NOT_ON_JOB and OFF_PLAN (run.removed, an existing visit, office writes)' => function () use ($put, $b) {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [], null, [50, 21])]]);
            T::err($put($e, 'r5', 12, $b(1, 0), 'bala'), 409, 'NOT_HOLDER'); // never held it
            T::err($put($e, 'r50', 21, $b(2, 0), 'ali'), 409, 'NOT_HOLDER'); // no run
            T::err($put($e, 'r41', 12, $b(3, 0), 'ali', '2026-11-12'), 409, 'NOT_HOLDER'); // future: runs never exist
            T::err($put($e, 'r5', 70, $b(4, 0), 'ali'), 422, 'NOT_ON_JOB'); // never on the route
            T::err($put($e, 'r5', 999, $b(5, 0), 'ali'), 422, 'NOT_ON_JOB');
            // removed by the office after the driver loaded it: accepted as OFF_PLAN
            $r = $put($e, 'r5', 21, $b(6, 0), 'ali');
            T::subset(['visit' => ['flags' => ['OFF_PLAN']], 'progress' => ['collected' => 1, 'pending' => 2, 'total' => 3]], T::ok($r));
            T::eq('OFF_PLAN', $r['json']['warnings'][0]['code']);
            // an OFF_PLAN customer with no routable type left may be weighed in any active routable type
            T::ok($put($e, 'r5', 50, $b(7, 0, 'collected', ['weights' => ['REL' => 3]]), 'ali'));
            $o = RunsFx::occ($e, 'r5@2026-11-11');
            T::eq([21, 50], array_column($o['off_plan'], 'customer_id'));
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::subset([['customer' => ['id' => 21], 'on_plan' => false, 'seq' => 3, 'weigh_types' => ['REL']], ['customer' => ['id' => 50], 'on_plan' => false, 'weigh_types' => ['REL']]],
                array_slice($j['stops'], 2));
            // the office may record any routable customer as OFF_PLAN, never a non-routable one
            T::subset(['visit' => ['flags' => ['OFF_PLAN'], 'driver_id' => 3]], T::ok($put($e, 'r5', 70, $b(8, 0), 'mei', RunsFx::WED, true)));
            $only = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3)]]);
            T::err($put($only, 'r5', 50, $b(9, 0, 'collected', ['weights' => ['REL' => 3]]), 'mei', RunsFx::WED, true), 422, 'NOT_ON_JOB');
            T::err($put($only, 'r5', 999, $b(10, 0), 'mei', RunsFx::WED, true), 422, 'NOT_ON_JOB');
        },

        'office: WHY_REQUIRED + OFFICE_EDITED; back-fill creates a holder-less run (driver_id may be set); dates <= today' => function () use ($put, $b) {
            $e = RunsFx::env();
            $d = T::ok($put($e, 'r50', 21, $b(1, 0, 'collected', ['weights' => ['REL' => 7], 'driver_id' => 4]), 'mei', RunsFx::WED, true));
            T::subset(['visit' => ['driver_id' => 4, 'by' => 'user:2', 'flags' => [], 'rev' => 1, 'why' => null, 'history' => []],
                'run' => ['driver' => null, 'collected' => 1, 'pending' => 0]], $d);
            T::subset(['job' => 'r50', 'driver_id' => null, 'holds' => []], RunsFx::diskRun($e, 'r50'));
            T::eq('done', RunsFx::occ($e, 'r50@2026-11-11')['run_status']);
            T::subset(['field' => 'why'], T::err($put($e, 'r50', 21, $b(2, 1, 'collected', ['weights' => ['REL' => 8]]), 'mei', RunsFx::WED, true), 422, 'WHY_REQUIRED'));
            T::err($put($e, 'r50', 21, $b(3, 1, 'collected', ['weights' => ['REL' => 8], 'why' => ' ']), 'mei', RunsFx::WED, true), 422, 'WHY_REQUIRED');
            $d = T::ok($put($e, 'r50', 21, $b(4, 1, 'collected', ['weights' => ['REL' => 8], 'why' => 'typo', 'driver_id' => 3]), 'admin', RunsFx::WED, true));
            T::subset(['rev' => 2, 'by' => 'user:1', 'driver_id' => 4, 'flags' => ['OFFICE_EDITED'], 'why' => 'typo',
                'history' => [['rev' => 1, 'by' => 'user:2', 'weights' => ['REL' => 7.0], 'driver_id' => 4]]], $d['visit']);
            T::err($put($e, 'r5', 12, $b(5, 0, 'collected', ['driver_id' => 2]), 'mei', RunsFx::WED, true), 422, 'VALIDATION'); // not a driver
            T::err($put($e, 'r41', 12, $b(6, 0), 'mei', '2026-11-12', true), 422, 'NOT_TODAY');
            T::err($put($e, 'r7', 21, $b(7, 0), 'mei', RunsFx::WED, true), 404, 'NOT_FOUND');
            T::err($put($e, 'r50', 21, $b(8, 2), 'ali'), 409, 'NOT_HOLDER');
            T::err($put($e, 'r50', 21, $b(9, 2, 'collected', ['why' => 'x']), 'ali', RunsFx::WED, true), 403, 'FORBIDDEN');
            $c = RunsFx::env(['plan' => ['route_overrides' => [['route_id' => 5, 'date' => '2026-11-11', 'cancelled' => true, 'stops' => null, 'note' => '']]]]);
            T::err($put($c, 'r5', 12, $b(10, 0), 'mei', RunsFx::WED, true), 422, 'NOT_RUNNABLE');
            // GET /api/runs: holds, removed and full visits with history
            $g = T::ok($e->call('GET', '/api/runs/2026-11-11/r50', null, 'mei'));
            T::subset(['job' => 'r50', 'status' => 'done', 'holds' => [], 'removed' => [], 'mine' => false,
                'visits' => ['21' => ['rev' => 2, 'ops' => ['$len' => 2], 'history' => ['$len' => 1]]], 'run' => ['collected' => 1]], $g);
        },

        'undo: the driver puts a stop back to pending; undoing a pending stop changes nothing' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            T::ok($put($e, 'r5', 40, $b(1, 0, 'missed'), 'ali'));
            $d = T::ok($put($e, 'r5', 40, $b(2, 1, null, ['captured_at' => '2026-11-11T09:59:00+08:00']), 'ali'));
            T::subset(['visit' => ['outcome' => null, 'reason' => null, 'rev' => 2], 'progress' => ['missed' => 0, 'pending' => 2]], $d);
            T::eq('active', RunsFx::occ($e, 'r5@2026-11-11')['run_status']);
            $d = T::ok($put($e, 'r5', 40, $b(3, 2, null), 'ali'));
            T::eq(2, $d['visit']['rev'], 'nothing to undo');
            $d = T::ok($put($e, 'r5', 12, $b(4, 0, null), 'ali'));
            T::eq(null, $d['visit']);
        },

        'R31 + R32: the same customer on a route and a task; day totals count both, night-shift visits count for the job date' => function () use ($held, $put, $b) {
            $e = RunsFx::env(['runs' => $held()]);
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::eq([['job' => 't6', 'label' => 'OTC task', 'outcome' => null]], $j['stops'][0]['also_on']);
            T::eq([['job' => 't12', 'label' => 'COMPACTOR task', 'outcome' => null]], $j['stops'][1]['also_on']);
            $t = T::ok($e->call('GET', '/api/driver/today', null, 'ali'));
            T::eq([['job' => 'r5', 'code' => 'N1']], array_values(array_filter($t['tasks'], static fn ($x) => $x['job'] === 't6'))[0]['also_on']);
            T::ok($put($e, 't6', 12, $b(1, 0, 'collected', ['weights' => ['OTC' => '30,2']]), 'ali'));
            T::ok($put($e, 'r5', 12, $b(2, 0, 'collected', ['weights' => ['REL' => 120.5]]), 'ali'));
            $j = T::ok($e->call('GET', '/api/driver/runs/2026-11-11/r5', null, 'ali'));
            T::eq('collected', $j['stops'][0]['also_on'][0]['outcome']);
            T::eq([['job' => 'r5', 'label' => 'N1', 'outcome' => 'collected']], T::ok($e->call('GET', '/api/driver/runs/2026-11-11/t6', null, 'ali'))['stops'][0]['also_on']);
            $day = static function (TestEnv $e, string $date): array {
                foreach (T::ok($e->call('GET', '/api/calendar?view=week&anchor=' . $date, null, 'mei'))['days'] as $d) {
                    if ($d['date'] === $date) {
                        return $d;
                    }
                }
                T::fail('no day');
            };
            T::subset(['totals' => ['REL' => 120.5, 'OTC' => 30.2], 'provisional' => true], $day($e, '2026-11-11'));
            // night shift: 02:30 on Thu is still Wednesday; the stop is not LATE and counts in Wednesday's totals
            $e->setNow('2026-11-12T02:30:00+08:00');
            $r = T::ok($put($e, 'r5', 40, $b(3, 0, 'collected', ['weights' => ['REL' => 80], 'captured_at' => '2026-11-12T02:29:00+08:00']), 'ali'));
            T::eq([], $r['visit']['flags']);
            T::subset(['totals' => ['REL' => 200.5, 'OTC' => 30.2], 'ops' => ['done' => 2, 'active' => 0]], $day($e, '2026-11-11'));
            T::subset(['totals' => []], $day($e, '2026-11-12'));
            // the day stays provisional while a job is active or open: t12 is still not started, r50 too
            T::eq(false, $day($e, '2026-11-11')['provisional']);
            T::ok(RunsFx::claim($e, 't12', 'ali'), 201);
            T::eq(true, $day($e, '2026-11-11')['provisional']);
        },
    ];
})();
