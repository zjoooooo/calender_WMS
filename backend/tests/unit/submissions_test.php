<?php
// Free submissions of the non-routable waste types (round 7, src/Submissions.php): no task, no claim.
//   PUT /api/driver/submissions/{date}/{id}   create / change / delete (outcome null), idempotent by id and op_id
//   GET /api/driver/customers, GET /api/driver/submissions, GET /api/submissions (office)
// Setup: tests/runs_lib.php (today Wed 2026-11-11): customers 12 (REL, OTC), 40 (REL, COMPACTOR), 50 (OTC),
// 21 (REL), 60 (inactive); drivers ali (3), bala (4), chong (5); plates SBA1234X, GBA1234X (OLD999Z inactive).
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $sub = [RunsFx::class, 'sub'];
    $b = [RunsFx::class, 'subBody'];
    $disk = static fn (TestEnv $e, int $n, string $date = RunsFx::WED) => $e->doc('day:' . $date)['submissions'][RunsFx::op($n)] ?? null;
    $mine = static fn (TestEnv $e, string $as = 'ali', string $qs = '') => T::ok($e->call('GET', '/api/driver/submissions' . $qs, null, $as));
    $office = static fn (TestEnv $e, string $qs = '') => T::ok($e->call('GET', '/api/submissions' . $qs, null, 'mei'));
    $day = static function (TestEnv $e, string $date): array {
        foreach (T::ok($e->call('GET', '/api/calendar?view=week&anchor=' . $date, null, 'mei'))['days'] as $d) {
            if ($d['date'] === $date) {
                return $d;
            }
        }
        T::fail('no day');
    };

    return [
        'create: 201, the record (type, customer snapshot, normalised plate, weights), stored under the day\'s submissions' => function () use ($sub, $b, $disk) {
            $e = RunsFx::env();
            $r = $sub($e, 1, $b(1, ['vehicle_no' => ' sba 1234x ', 'weights' => ['OTC' => '30,5'], 'note' => 'sofa', 'captured_at' => '2026-11-11T09:59:00+08:00']));
            $d = T::ok($r, 201);
            T::eq([], $r['json']['warnings']);
            T::subset(['replay' => false, 'submission' => ['id' => RunsFx::op(1), 'date' => '2026-11-11', 'waste_type' => 'OTC', 'customer_id' => 12,
                'vehicle_no' => 'SBA1234X', 'outcome' => 'collected', 'weights' => ['OTC' => 30.5], 'tickets' => [], 'photos' => [], 'signature' => null,
                'reason' => null, 'note' => 'sofa', 'driver_id' => 3, 'by' => 'user:3', 'rev' => 1, 'flags' => [],
                'customer' => ['code' => 'C0012', 'name' => 'ABC Restaurant', 'address' => '12 Jalan Besar'],
                'captured_at' => '2026-11-11T09:59:00+08:00', 'received_at' => '2026-11-11T10:00:00+08:00',
                'ops' => ['$absent' => true], 'history' => ['$absent' => true]]], $d);
            T::true(str_contains($r['response']->body, '"tickets":{}'), 'empty tickets encode as {}');
            T::subset(['id' => RunsFx::op(1), 'waste_type' => 'OTC', 'rev' => 1, 'ops' => [['op_id' => RunsFx::op(1), 'result' => 'applied']], 'history' => []], $disk($e, 1));
            T::eq(['date', 'plan', 'runs', 'dropped_runs', 'submissions'], array_keys($e->doc('day:2026-11-11')));
            T::eq([], $e->doc('day:2026-11-11')['runs'], 'no run and no claim is involved');
            // COMPACTOR for a customer registered with it, with another plate; a second OTC for the same customer is a second record
            T::ok($sub($e, 2, $b(2, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'weights' => ['COMPACTOR' => 800], 'vehicle_no' => 'GBA1234X'])), 201);
            T::ok($sub($e, 3, $b(3)), 201);
            T::eq(3, count($e->doc('day:2026-11-11')['submissions']));
            T::subset([['method' => 'PUT', 'path' => '/api/driver/submissions/2026-11-11/' . RunsFx::op(1), 'username' => 'ali', 'status' => 201],
                ['status' => 201], ['status' => 201]], $e->doc('audit:2026-11'));
        },

        'a resend never makes a second record: the same op_id is a replay, a new op_id on the same id is an edit' => function () use ($sub, $b, $disk, $mine) {
            $e = RunsFx::env();
            T::ok($sub($e, 1, $b(1)), 201);
            $before = $e->doc('day:2026-11-11');
            $e->setNow('2026-11-11T10:05:00+08:00');
            $d = T::ok($sub($e, 1, $b(1)), 200); // the response was lost: the phone sends the same body again
            T::subset(['replay' => true, 'submission' => ['rev' => 1, 'received_at' => '2026-11-11T10:00:00+08:00']], $d);
            T::eq($before, $e->doc('day:2026-11-11'), 'a replay changes nothing');
            // a replay is answered before every other rule (here: a body that would now be refused)
            T::subset(['replay' => true], T::ok($sub($e, 1, $b(1, ['vehicle_no' => 'OLD999Z', 'weights' => ['OTC' => 0]])), 200));
            // an edit: same id, new op_id
            $d = T::ok($sub($e, 1, $b(2, ['base_rev' => 1, 'weights' => ['OTC' => 61.5], 'vehicle_no' => 'GBA1234X', 'note' => 're-weighed'])), 200);
            T::subset(['replay' => false, 'submission' => ['rev' => 2, 'weights' => ['OTC' => 61.5], 'vehicle_no' => 'GBA1234X', 'note' => 're-weighed',
                'received_at' => '2026-11-11T10:05:00+08:00']], $d);
            T::subset(['rev' => 2, 'ops' => ['$len' => 2], 'history' => [['rev' => 1, 'weights' => ['OTC' => 50.0], 'by' => 'user:3', 'rejected' => false]]], $disk($e, 1));
            T::eq(1, count($e->doc('day:2026-11-11')['submissions']));
            // a stale base_rev from the same driver is still applied (R30 step 3: a lost response followed by a new edit)
            T::subset(['submission' => ['rev' => 3]], T::ok($sub($e, 1, $b(3, ['base_rev' => 1, 'weights' => ['OTC' => 62]])), 200));
            T::eq([RunsFx::op(1)], array_column($mine($e)['submissions'], 'id'));
        },

        'delete = outcome null: gone from the lists and the totals, the record and its history stay on disk; the id can be used again' => function () use ($sub, $b, $disk, $mine, $office, $day) {
            $e = RunsFx::env();
            T::ok($sub($e, 1, $b(1)), 201);
            T::ok($sub($e, 2, $b(2, ['weights' => ['OTC' => 7]])), 201);
            T::subset(['totals' => ['OTC' => 57.0]], $day($e, '2026-11-11'));
            $d = T::ok($sub($e, 1, ['op_id' => RunsFx::op(3), 'base_rev' => 1, 'outcome' => null]), 200);
            T::subset(['submission' => ['id' => RunsFx::op(1), 'outcome' => null, 'weights' => [], 'rev' => 2, 'vehicle_no' => 'SBA1234X']], $d);
            T::eq([RunsFx::op(2)], array_column($mine($e)['submissions'], 'id'));
            T::subset(['totals' => ['OTC' => 7.0], 'submissions' => [['id' => RunsFx::op(2)]]], $office($e));
            T::subset(['totals' => ['OTC' => 7.0]], $day($e, '2026-11-11'));
            T::subset(['outcome' => null, 'rev' => 2, 'waste_type' => 'OTC', 'customer_id' => 12, 'history' => [['rev' => 1, 'outcome' => 'collected', 'weights' => ['OTC' => 50.0]]]], $disk($e, 1));
            // deleting it again, or deleting an id that never existed, does nothing
            T::subset(['submission' => ['rev' => 2]], T::ok($sub($e, 1, ['op_id' => RunsFx::op(4), 'base_rev' => 2, 'outcome' => null]), 200));
            T::eq(['submission' => null, 'replay' => false], T::ok($sub($e, 9, ['op_id' => RunsFx::op(5), 'base_rev' => 0, 'outcome' => null]), 200));
            T::eq(null, $disk($e, 9));
            // the deleted id submitted again
            T::subset(['submission' => ['rev' => 3, 'outcome' => 'collected', 'weights' => ['OTC' => 5.0]]], T::ok($sub($e, 1, $b(6, ['base_rev' => 2, 'weights' => ['OTC' => 5]])), 200));
            T::subset(['totals' => ['OTC' => 12.0]], $day($e, '2026-11-11'));
        },

        'only the driver who made it: another driver gets 404 and never sees it' => function () use ($sub, $b, $disk, $mine) {
            $e = RunsFx::env();
            T::ok($sub($e, 1, $b(1)), 201);
            T::err($sub($e, 1, $b(2, ['base_rev' => 1, 'weights' => ['OTC' => 1]]), 'bala'), 404, 'NOT_FOUND');
            T::err($sub($e, 1, ['op_id' => RunsFx::op(3), 'base_rev' => 1, 'outcome' => null], 'bala'), 404, 'NOT_FOUND');
            T::err($sub($e, 1, $b(1), 'bala'), 404, 'NOT_FOUND'); // not even a replay of Ali's op
            T::subset(['rev' => 1, 'driver_id' => 3, 'weights' => ['OTC' => 50.0]], $disk($e, 1));
            T::eq([], $mine($e, 'bala')['submissions']);
            T::ok($sub($e, 2, $b(4, ['customer_id' => 50]), 'bala'), 201);
            T::eq([RunsFx::op(2)], array_column($mine($e, 'bala')['submissions'], 'id'));
            T::eq([RunsFx::op(1)], array_column($mine($e, 'ali')['submissions'], 'id'));
        },

        'the date: today or up to 7 days back (LATE), never tomorrow; the operational day ends at the rollover' => function () use ($sub, $b, $disk, $day) {
            $e = RunsFx::env();
            T::subset(['field' => 'date', 'details' => ['today' => '2026-11-11', 'oldest' => '2026-11-04']],
                T::err($sub($e, 1, $b(1), 'ali', '2026-11-12'), 422, 'NOT_TODAY'));
            T::err($sub($e, 2, $b(2), 'ali', '2026-11-03'), 422, 'NOT_TODAY');
            T::err($sub($e, 3, $b(3), 'ali', '2026-13-01'), 422, 'VALIDATION');
            $r = $sub($e, 4, $b(4, ['captured_at' => '2026-11-10T22:00:00+08:00']), 'ali', '2026-11-10'); // the phone was offline last night
            T::subset(['submission' => ['date' => '2026-11-10', 'flags' => ['LATE'], 'captured_at' => '2026-11-10T22:00:00+08:00']], T::ok($r, 201));
            T::eq('LATE', $r['json']['warnings'][0]['code']);
            T::subset(['flags' => ['LATE']], $disk($e, 4, '2026-11-10'));
            T::subset(['submission' => ['flags' => ['LATE']]], T::ok($sub($e, 5, $b(5), 'ali', '2026-11-04'), 201));
            T::subset(['totals' => ['OTC' => 50.0], 'past' => true], $day($e, '2026-11-10'));
            T::eq(null, $e->doc('day:2026-11-12'));
            // night shift: 03:30 on Thu is still Wednesday (not LATE, Thursday refused); at 04:00 Wednesday is over
            $n = RunsFx::env();
            $n->setNow('2026-11-12T03:30:00+08:00');
            T::subset(['submission' => ['date' => '2026-11-11', 'flags' => []]], T::ok($sub($n, 1, $b(1, ['captured_at' => '2026-11-12T03:29:00+08:00'])), 201));
            T::err($sub($n, 2, $b(2), 'ali', '2026-11-12'), 422, 'NOT_TODAY');
            $n->setNow('2026-11-12T04:00:00+08:00');
            T::subset(['submission' => ['date' => '2026-11-11', 'flags' => ['LATE']]], T::ok($sub($n, 3, $b(3)), 201));
            T::subset(['submission' => ['date' => '2026-11-12', 'flags' => []]], T::ok($sub($n, 2, $b(2), 'ali', '2026-11-12'), 201));
            T::subset(['totals' => ['OTC' => 100.0]], $day($n, '2026-11-11'));
            T::subset(['totals' => ['OTC' => 50.0]], $day($n, '2026-11-12'));
            T::eq(true, is_array($n->doc('day:2026-11-11')['plan']), 'the freeze of Wednesday kept its submissions');
            T::eq(2, count($n->doc('day:2026-11-11')['submissions']));
        },

        'waste type and customer: TYPE_ROUTABLE, TYPE_NOT_ALLOWED, CUSTOMER_INACTIVE, CUSTOMER_LACKS_TYPE' => function () use ($sub, $b) {
            $e = RunsFx::env();
            T::subset(['field' => 'waste_type'], T::err($sub($e, 1, $b(1, ['waste_type' => 'REL', 'weights' => ['REL' => 5]])), 422, 'TYPE_ROUTABLE'));
            T::err($sub($e, 1, $b(2, ['waste_type' => 'RECYCLING', 'weights' => ['RECYCLING' => 5]])), 422, 'TYPE_ROUTABLE');
            T::subset(['details' => ['waste_type' => 'GLS']], T::err($sub($e, 1, $b(3, ['waste_type' => 'GLS', 'weights' => ['GLS' => 5]])), 422, 'TYPE_NOT_ALLOWED'));
            $nt = $b(4);
            unset($nt['waste_type']);
            T::subset(['field' => 'waste_type'], T::err($sub($e, 1, $nt), 422, 'VALIDATION'));
            T::subset(['field' => 'customer_id', 'details' => ['customer_id' => 60]], T::err($sub($e, 1, $b(5, ['customer_id' => 60])), 422, 'CUSTOMER_INACTIVE'));
            T::subset(['field' => 'customer_id', 'details' => ['customer_id' => 40, 'name' => 'Golden Bakery', 'waste_type' => 'OTC']],
                T::err($sub($e, 1, $b(6, ['customer_id' => 40])), 422, 'CUSTOMER_LACKS_TYPE'));
            T::err($sub($e, 1, $b(7, ['waste_type' => 'EROSE', 'weights' => ['EROSE' => 5]])), 422, 'CUSTOMER_LACKS_TYPE');
            T::err($sub($e, 1, $b(8, ['customer_id' => 999])), 422, 'VALIDATION');
            T::err($sub($e, 1, $b(9, ['customer_id' => '12'])), 422, 'VALIDATION');
            T::eq(null, $e->doc('day:2026-11-11')['submissions'][RunsFx::op(1)] ?? null, 'nothing refused was stored');
            // EROSE once a customer registers it
            T::ok($e->call('PATCH', '/api/customers/50', ['waste_types' => ['OTC', 'EROSE']], 'mei'));
            T::subset(['submission' => ['waste_type' => 'EROSE', 'weights' => ['EROSE' => 12.0], 'customer' => ['name' => 'Only OTC Co']]],
                T::ok($sub($e, 1, $b(10, ['waste_type' => 'EROSE', 'customer_id' => 50, 'weights' => ['EROSE' => 12]])), 201));
            // an inactive type is refused for new submissions
            $off = RunsFx::env(['plan' => ['waste_types' => array_map(static fn ($t) => ['active' => $t['code'] !== 'OTC'] + $t, Seed::WASTE_TYPES)]]);
            T::err($sub($off, 1, $b(11)), 422, 'TYPE_NOT_ALLOWED');
        },

        'content as for a route stop: plate, weights, weighbridge ticket, files, note; "missed" is refused' => function () use ($sub, $b) {
            $e = RunsFx::env();
            $np = $b(1);
            unset($np['vehicle_no']);
            T::subset(['field' => 'vehicle_no'], T::err($sub($e, 1, $np), 422, 'VEHICLE_REQUIRED'));
            T::err($sub($e, 1, $b(2, ['vehicle_no' => '  '])), 422, 'VEHICLE_REQUIRED');
            T::subset(['details' => ['plate' => 'OLD999Z']], T::err($sub($e, 1, $b(3, ['vehicle_no' => 'old 999z'])), 422, 'VEHICLE_UNKNOWN'));
            foreach ([12.55, -1, 100000, 'abc', true] as $n => $bad) {
                T::subset(['field' => 'weights.OTC'], T::err($sub($e, 1, $b(10 + $n, ['weights' => ['OTC' => $bad]])), 422, 'WEIGHT_INVALID'));
            }
            T::err($sub($e, 1, $b(20, ['weights' => ['OTC' => 0]])), 422, 'WEIGHT_REQUIRED');
            T::err($sub($e, 1, $b(21, ['weights' => []])), 422, 'WEIGHT_REQUIRED');
            T::subset(['field' => 'weights.REL', 'details' => ['allowed' => ['OTC']]],
                T::err($sub($e, 1, $b(22, ['weights' => ['OTC' => 5, 'REL' => 5]])), 422, 'TYPE_NOT_ALLOWED')); // customer 12 has REL, but this is an OTC submission
            T::err($sub($e, 1, $b(23, ['weights' => ['COMPACTOR' => 5]])), 422, 'TYPE_NOT_ALLOWED');
            T::err($sub($e, 1, $b(24, ['outcome' => 'missed', 'weights' => (object) [], 'reason' => 'closed'])), 422, 'VALIDATION');
            T::err($sub($e, 1, $b(25, ['outcome' => 'done'])), 422, 'VALIDATION');
            T::err($sub($e, 1, $b(26, ['note' => str_repeat('x', 501)])), 422, 'VALIDATION');
            T::err($sub($e, 1, $b(27, ['extra' => 1])), 422, 'VALIDATION');
            T::err($sub($e, 1, ['op_id' => 'not-a-uuid'] + $b(28)), 422, 'VALIDATION');
            $nr = $b(29);
            unset($nr['base_rev']);
            T::err($sub($e, 1, $nr), 422, 'VALIDATION');
            $no = $b(30);
            unset($no['outcome']);
            T::err($sub($e, 1, $no), 422, 'VALIDATION');
            T::err($e->call('PUT', '/api/driver/submissions/2026-11-11/abc', $b(31), 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('PUT', '/api/driver/submissions/2026-11-11/NOT-A-UUID', $b(32), 'ali'), 404, 'NOT_FOUND');
            // files: a reference that was not uploaded, then a photo and a signature
            $photo = RunsFx::op(501) . '.jpg';
            $sig = RunsFx::op(502) . '.png';
            T::subset(['field' => 'photos.0', 'details' => ['file' => $photo]], T::err($sub($e, 1, $b(33, ['photos' => [$photo]])), 422, 'FILE_MISSING'));
            T::err($sub($e, 1, $b(34, ['signature' => $sig])), 422, 'FILE_MISSING');
            T::eq([], (array) ($e->doc('day:2026-11-11')['submissions'] ?? []), 'no refused write was stored');
            T::ok(RunsFx::upload($e, $photo, RunsFx::jpeg()), 201);
            T::ok(RunsFx::upload($e, $sig, RunsFx::png()), 201);
            $d = T::ok($sub($e, 1, $b(35, ['photos' => [$photo], 'signature' => $sig, 'note' => 'ok', 'tickets' => ['OTC' => 'T1']])), 201);
            T::subset(['photos' => ['files/00/' . $photo], 'signature' => 'files/00/' . $sig, 'note' => 'ok'], $d['submission']);
            T::eq([], (array) $d['submission']['tickets'], 'OTC is weighed on site: a ticket sent anyway is dropped');
            // a weighbridge type needs its ticket
            $wt = Seed::WASTE_TYPES;
            $wt[2]['weigh_method'] = 'weighbridge'; // OTC
            $w = RunsFx::env(['plan' => ['waste_types' => $wt]]);
            T::subset(['field' => 'tickets.OTC'], T::err($sub($w, 1, $b(40)), 422, 'TICKET_REQUIRED'));
            T::err($sub($w, 1, $b(41, ['tickets' => ['OTC' => ' ']])), 422, 'TICKET_REQUIRED');
            T::eq(['OTC' => 'WB-881'], (array) T::ok($sub($w, 1, $b(42, ['tickets' => ['OTC' => 'WB-881']])), 201)['submission']['tickets']);
        },

        'an edit: the type and the customer never change; it still works after the customer or the type changed; the edit window' => function () use ($sub, $b, $disk) {
            $e = RunsFx::env();
            T::ok($sub($e, 1, $b(1)), 201);
            T::subset(['field' => 'waste_type'], T::err($sub($e, 1, $b(2, ['base_rev' => 1, 'waste_type' => 'COMPACTOR', 'weights' => ['COMPACTOR' => 5]])), 422, 'VALIDATION'));
            T::subset(['field' => 'customer_id'], T::err($sub($e, 1, $b(3, ['base_rev' => 1, 'customer_id' => 50])), 422, 'VALIDATION'));
            // the customer is renamed, loses OTC and is archived; OTC is deactivated: the driver can still correct the record
            T::ok($e->call('PATCH', '/api/customers/12', ['name' => 'ABC Renamed', 'waste_types' => ['REL']], 'mei'));
            T::ok($e->call('POST', '/api/customers/12/archive', [], 'mei'));
            T::ok($e->call('PATCH', '/api/waste-types/OTC', ['active' => false], 'admin'));
            T::err($sub($e, 2, $b(4)), 422, 'TYPE_NOT_ALLOWED'); // a new one is refused
            $d = T::ok($sub($e, 1, $b(5, ['base_rev' => 1, 'weights' => ['OTC' => 51]])), 200);
            T::subset(['rev' => 2, 'weights' => ['OTC' => 51.0], 'customer' => ['name' => 'ABC Restaurant']], $d['submission']);
            // a body without type and customer (they are fixed) is fine too
            $short = $b(6, ['base_rev' => 2, 'weights' => ['OTC' => 52]]);
            unset($short['waste_type'], $short['customer_id']);
            T::subset(['submission' => ['rev' => 3, 'waste_type' => 'OTC', 'customer_id' => 12]], T::ok($sub($e, 1, $short), 200));
            // the edit window of a route stop (R28): until the day's rollover + 8 h
            $e->setNow('2026-11-12T11:59:00+08:00');
            T::subset(['submission' => ['rev' => 4, 'flags' => ['LATE']]], T::ok($sub($e, 1, $b(7, ['base_rev' => 3, 'weights' => ['OTC' => 53]])), 200));
            $e->setNow('2026-11-12T12:00:00+08:00');
            T::subset(['details' => ['deadline' => '2026-11-12T12:00:00+08:00']], T::err($sub($e, 1, $b(8, ['base_rev' => 4, 'weights' => ['OTC' => 54]])), 422, 'EDIT_WINDOW_CLOSED'));
            T::err($sub($e, 1, ['op_id' => RunsFx::op(9), 'base_rev' => 4, 'outcome' => null]), 422, 'EDIT_WINDOW_CLOSED');
            T::subset(['replay' => true], T::ok($sub($e, 1, $b(7, ['base_rev' => 3, 'weights' => ['OTC' => 53]])), 200)); // a replay still answers
            T::subset(['rev' => 4, 'weights' => ['OTC' => 53.0]], $disk($e, 1));
        },

        'roles: only drivers write and read their own; the office only reads; no token is 401' => function () use ($sub, $b) {
            $e = RunsFx::env();
            foreach (['mei', 'admin'] as $u) {
                T::err($sub($e, 1, $b(1), $u), 403, 'FORBIDDEN');
                T::err($e->call('GET', '/api/driver/submissions', null, $u), 403, 'FORBIDDEN');
                T::err($e->call('GET', '/api/driver/customers', null, $u), 403, 'FORBIDDEN');
                T::ok($e->call('GET', '/api/submissions', null, $u));
            }
            T::err($e->call('GET', '/api/submissions', null, 'ali'), 403, 'FORBIDDEN');
            T::err($e->call('GET', '/api/submissions', null), 401, 'UNAUTHORIZED');
            T::err($e->call('PUT', '/api/driver/submissions/2026-11-11/' . RunsFx::op(1), $b(1)), 401, 'UNAUTHORIZED');
            // the office has no write endpoint in this version
            foreach (['PUT', 'POST', 'DELETE', 'PATCH'] as $m) {
                T::err($e->call($m, '/api/submissions/2026-11-11/' . RunsFx::op(1), $b(1), 'mei'), 404, 'NOT_FOUND');
            }
            T::err($e->call('DELETE', '/api/driver/submissions/2026-11-11/' . RunsFx::op(1), null, 'ali'), 404, 'NOT_FOUND');
            T::eq(null, $e->doc('day:2026-11-11')['submissions'][RunsFx::op(1)] ?? null);
        },

        'GET /api/driver/customers: active customers with an active non-routable type, only those types, by name' => function () {
            $e = RunsFx::env();
            $list = T::ok($e->call('GET', '/api/driver/customers', null, 'ali'));
            T::eq([
                ['id' => 12, 'code' => 'C0012', 'name' => 'ABC Restaurant', 'address' => '12 Jalan Besar', 'waste_types' => ['OTC']],
                ['id' => 40, 'code' => 'C0040', 'name' => 'Golden Bakery', 'address' => '5 Tuas South Ave 2', 'waste_types' => ['COMPACTOR']],
                ['id' => 50, 'code' => 'C0050', 'name' => 'Only OTC Co', 'address' => '9 Kallang Rd', 'waste_types' => ['OTC']],
            ], $list, 'REL is left out; 21 / 70 (REL only) and 60 (inactive) are not listed');
            T::ok($e->call('PATCH', '/api/customers/50', ['waste_types' => ['OTC', 'COMPACTOR', 'EROSE']], 'mei'));
            T::ok($e->call('PATCH', '/api/waste-types/OTC', ['active' => false], 'admin'));
            T::ok($e->call('POST', '/api/customers/40/archive', [], 'mei'));
            T::eq([['id' => 50, 'waste_types' => ['COMPACTOR', 'EROSE']]],
                array_map(static fn ($x) => ['id' => $x['id'], 'waste_types' => $x['waste_types']], T::ok($e->call('GET', '/api/driver/customers', null, 'bala'))));
        },

        'GET lists: the driver sees their own by day; the office sees every driver with totals, names and history' => function () use ($sub, $b, $mine, $office) {
            $e = RunsFx::env();
            T::ok($sub($e, 1, $b(1)), 201);
            $e->setNow('2026-11-11T10:01:00+08:00');
            T::ok($sub($e, 2, $b(2, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'weights' => ['COMPACTOR' => 800.5]]), 'bala'), 201);
            $e->setNow('2026-11-11T10:02:00+08:00');
            T::ok($sub($e, 3, $b(3, ['customer_id' => 50, 'weights' => ['OTC' => 20]]), 'bala'), 201);
            $e->setNow('2026-11-11T10:03:00+08:00');
            T::ok($sub($e, 1, $b(4, ['base_rev' => 1, 'weights' => ['OTC' => 55]])), 200);
            T::ok($sub($e, 4, $b(5), 'ali', '2026-11-10'), 201);
            T::subset(['today' => '2026-11-11', 'date' => '2026-11-11', 'submissions' => [['id' => RunsFx::op(1), 'weights' => ['OTC' => 55.0], 'history' => ['$absent' => true]]]], $mine($e));
            T::eq([RunsFx::op(4)], array_column($mine($e, 'ali', '?date=2026-11-10')['submissions'], 'id'));
            T::eq([RunsFx::op(2), RunsFx::op(3)], array_column($mine($e, 'bala')['submissions'], 'id'));
            T::err($e->call('GET', '/api/driver/submissions?date=yesterday', null, 'ali'), 422, 'VALIDATION');
            $o = $office($e);
            T::subset(['today' => '2026-11-11', 'date' => '2026-11-11', 'totals' => ['OTC' => 75.0, 'COMPACTOR' => 800.5]], $o);
            // by the time the server received the current version
            T::eq([RunsFx::op(2), RunsFx::op(3), RunsFx::op(1)], array_column($o['submissions'], 'id'));
            T::subset(['id' => RunsFx::op(1), 'driver' => 'Ali', 'driver_id' => 3, 'waste_type' => 'OTC', 'vehicle_no' => 'SBA1234X', 'rev' => 2,
                'customer' => ['code' => 'C0012', 'name' => 'ABC Restaurant'], 'ops' => ['$len' => 2], 'history' => [['rev' => 1, 'weights' => ['OTC' => 50.0]]]],
                $o['submissions'][2]);
            T::subset(['driver' => 'Bala', 'waste_type' => 'COMPACTOR', 'customer' => ['name' => 'Golden Bakery']], $o['submissions'][0]);
            T::subset(['date' => '2026-11-10', 'totals' => ['OTC' => 50.0], 'submissions' => [['id' => RunsFx::op(4), 'flags' => ['LATE']]]], $office($e, '?date=2026-11-10'));
            $empty = $office($e, '?date=2026-11-09');
            T::eq(['today' => '2026-11-11', 'date' => '2026-11-09', 'totals' => [], 'submissions' => [], 'visits' => []], $empty);
            T::err($e->call('GET', '/api/submissions?date=2026-02-30', null, 'mei'), 422, 'VALIDATION');
        },

        'the calendar counts submissions in the day totals and lists none of them' => function () use ($sub, $b, $day) {
            $e = RunsFx::env(['runs' => ['r5' => RunsFx::run('r5', 3, [RunsFx::visit(12, 'collected', ['REL' => 120.5])])]]);
            T::subset(['totals' => ['REL' => 120.5, 'OTC' => ['$absent' => true]]], $day($e, '2026-11-11'));
            T::ok($sub($e, 1, $b(1, ['weights' => ['OTC' => '30,2']])), 201);
            T::ok($sub($e, 2, $b(2, ['waste_type' => 'COMPACTOR', 'customer_id' => 40, 'weights' => ['COMPACTOR' => 800]]), 'bala'), 201);
            T::ok($sub($e, 3, $b(3, ['customer_id' => 50, 'weights' => ['OTC' => 9.9]]), 'bala'), 201);
            $d = $day($e, '2026-11-11');
            T::subset(['totals' => ['REL' => 120.5, 'OTC' => 40.1, 'COMPACTOR' => 800.0], 'provisional' => true,
                'ops' => ['active' => 1, 'not_started' => 2, 'done' => 0, 'open' => 0]], $d);
            $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=2026-11-11', null, 'mei'));
            T::eq(false, array_key_exists('submissions', $cal) || array_key_exists('tasks', $cal));
            T::eq(['r50', 'r51', 'r5'], array_map(static fn ($o) => 'r' . $o['route_id'], array_values(array_filter($cal['routes'], static fn ($o) => $o['date'] === '2026-11-11'))),
                'only routes are on the calendar');
            // submissions never make a day provisional and are not jobs: the driver's Today list is unchanged
            $q = RunsFx::env();
            T::ok($sub($q, 1, $b(1)), 201);
            T::subset(['totals' => ['OTC' => 50.0], 'provisional' => false], $day($q, '2026-11-11'));
            $t = T::ok($q->call('GET', '/api/driver/today', null, 'ali'));
            T::subset(['my_route' => null, 'routes' => ['$len' => 2]], $t);
            // the month view counts them too
            $m = T::ok($q->call('GET', '/api/calendar?view=month&anchor=2026-11-11', null, 'mei'));
            T::eq(50.0, (float) array_values(array_filter($m['days'], static fn ($x) => $x['date'] === '2026-11-11'))[0]['totals']['OTC']);
        },
        'GET /api/submissions also lists the results recorded on the routes of that day' => function (): void {
        $e = RunsFx::env();
        T::ok(RunsFx::claim($e, 'r5', 'ali'), 201);
        T::ok(RunsFx::put($e, 'r5', 12, RunsFx::body(9, 0, 'collected', ['weights' => ['REL' => 120.5]]), 'ali'));
        T::ok(RunsFx::claim($e, 'r50', 'bala'), 201);
        T::ok(RunsFx::put($e, 'r50', 21, RunsFx::body(1, 0, 'collected', ['weights' => ['REL' => 55.5], 'note' => 'gate B']), 'bala'));
        T::ok(RunsFx::sub($e, 1, RunsFx::subBody(2)), 201);
        $r = T::ok($e->call('GET', '/api/submissions?date=' . RunsFx::WED, null, 'mei'));
        T::eq(1, count($r['submissions']), 'the free submission stays in its own list');
        $byId = array_column($r['visits'], null, 'id');
        T::eq(['r5/12', 'r50/21'], array_keys($byId), 'one row per recorded stop, by the time received');
        T::subset(['job' => 'r50', 'date' => RunsFx::WED, 'route' => ['code' => 'A2', 'type' => 'adhoc', 'name' => 'Adhoc today'], 'waste_type' => 'REL',
            'outcome' => 'collected', 'weights' => ['REL' => 55.5], 'vehicle_no' => 'SBA1234X', 'driver' => 'Bala', 'note' => 'gate B',
            'customer' => ['name' => 'Sunday Market Stall'], 'history' => []], $byId['r50/21'], 'a route record: route, type, weight, truck, driver, customer');
        T::subset(['route' => ['code' => 'N1', 'type' => 'regular'], 'waste_type' => 'REL', 'weights' => ['REL' => 120.5], 'driver' => 'Ali', 'vehicle_no' => 'SBA1234X'], $byId['r5/12'], 'a regular route record');
        // not collected is listed too, an undone stop is not
        T::ok(RunsFx::put($e, 'r50', 21, RunsFx::body(3, 1, 'missed', ['weights' => [], 'reason' => 'closed']), 'bala'));
        $r = T::ok($e->call('GET', '/api/submissions?date=' . RunsFx::WED, null, 'mei'));
        $row = array_column($r['visits'], null, 'id')['r50/21'];
        T::subset(['outcome' => 'missed', 'reason' => 'closed'], $row, 'a stop marked not collected is listed with its reason');
        T::eq(1, count($row['history']), 'with its history');
        T::ok(RunsFx::put($e, 'r50', 21, RunsFx::body(4, 2, null), 'bala'));
        $r = T::ok($e->call('GET', '/api/submissions?date=' . RunsFx::WED, null, 'mei'));
        T::eq(['r5/12'], array_column($r['visits'], 'id'), 'an undone stop is pending again: not listed');
        T::eq([], T::ok($e->call('GET', '/api/submissions?date=2026-11-12', null, 'mei'))['visits'], 'a day with no results');
        T::err($e->call('GET', '/api/submissions?date=' . RunsFx::WED, null, 'bala'), 403, 'FORBIDDEN');
    },
];
})();
