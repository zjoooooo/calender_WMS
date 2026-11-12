<?php
// HTTP smoke test: boots `php -S` on a port and drives the API over real HTTP (M1-M5 flow):
// first start + admin password, forced change, users, master data, routes/calendar, roles, lockout, the 03:59/04:00
// rollover (server restarted with WMS_FAKE_NOW on a .demo data dir), audit log, SPA fallback; then, on a freshly
// seeded data dir, the M6-M8 scripted day of §13 (claims, photo upload, switch, office edits, a free OTC submission, correction,
// night shift 02:30 / 03:59 / 04:00, close-out and back-fill).
//
//   php backend/tests/api_smoke.php [port=8180] [data_dir=<temp dir>]
//
// The data dir is WIPED first. The server is always stopped at the end. Exit code 0 = all passed.
// Later parts can append their own steps (routes, runs, submissions) using the helpers below.

$config = require __DIR__ . '/../bootstrap.php';

$port = (int) ($argv[1] ?? 8180);
$dataDir = rtrim($argv[2] ?? (sys_get_temp_dir() . '/wms-smoke-' . getmypid()), '/');
$docroot = sys_get_temp_dir() . '/wms-smoke-docroot-' . getmypid();
$logFile = sys_get_temp_dir() . '/wms-smoke-server-' . getmypid() . '.log';
$base = "http://127.0.0.1:$port";

$rmrf = static function (string $p) use (&$rmrf): void {
    if (is_file($p) || is_link($p)) {
        unlink($p);
        return;
    }
    if (is_dir($p)) {
        foreach (scandir($p) as $e) {
            if ($e !== '.' && $e !== '..') {
                $rmrf("$p/$e");
            }
        }
        rmdir($p);
    }
};

$server = null;
$stop = static function () use (&$server): void {
    if (is_resource($server)) {
        proc_terminate($server, 15);
        for ($i = 0; $i < 50 && proc_get_status($server)['running']; $i++) {
            usleep(20000);
        }
        if (proc_get_status($server)['running']) {
            proc_terminate($server, 9);
        }
        proc_close($server);
    }
    $server = null;
};
$start = static function (?string $fakeNow) use (&$server, $stop, $port, $dataDir, $docroot, $logFile, $base): void {
    $stop();
    $env = array_merge(getenv(), ['WMS_DATA_DIR' => $dataDir, 'WMS_FAKE_NOW' => $fakeNow ?? '']);
    $cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot, __DIR__ . '/../public/index.php'];
    $server = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['file', $logFile, 'a'], 2 => ['file', $logFile, 'a']], $pipes, null, $env);
    if (!is_resource($server)) {
        throw new RuntimeException('Cannot start php -S');
    }
    for ($i = 0; $i < 100; $i++) {
        $fp = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
        if ($fp) {
            fclose($fp);
            return;
        }
        usleep(50000);
    }
    throw new RuntimeException("php -S did not start on port $port (is the port free?)");
};

/** @return array{status:int,json:mixed,body:string,headers:array<string,string>} */
$http = static function (string $method, string $path, array|string|null $body = null, ?string $token = null) use ($base): array {
    $ch = curl_init($base . $path);
    $headers = ['Content-Type: application/json'];
    if ($token !== null) {
        $headers[] = "Authorization: Bearer $token";
    }
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$respHeaders): int {
            if (str_contains($line, ':')) {
                [$k, $v] = explode(':', $line, 2);
                $respHeaders[strtolower(trim($k))] = trim($v);
            }
            return strlen($line);
        },
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body));
    }
    $out = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $out = is_string($out) ? $out : '';
    return ['status' => $status, 'json' => json_decode($out, true), 'body' => $out, 'headers' => $respHeaders];
};

$passed = 0;
$failures = [];
$check = static function (string $name, bool $ok, string $detail = '') use (&$passed, &$failures): void {
    if ($ok) {
        $passed++;
        echo "  ok    $name\n";
    } else {
        $failures[] = $name;
        echo "  FAIL  $name" . ($detail !== '' ? "\n        $detail" : '') . "\n";
    }
};
$expect = static function (string $name, array $res, int $status, ?string $code = null) use ($check): mixed {
    $got = $res['json']['error']['code'] ?? null;
    $ok = $res['status'] === $status && ($code === null || $got === $code);
    $check($name, $ok, "expected $status " . ($code ?? '') . ", got {$res['status']} " . substr($res['body'], 0, 300));
    return $res['json']['data'] ?? null;
};

try {
    $rmrf($dataDir);
    mkdir($dataDir, 0777, true);
    touch("$dataDir/.demo");
    @mkdir($docroot, 0777, true);
    echo "php -S on $base, data dir $dataDir\n";

    // ---- M1: first start, admin password, forced change --------------------------------
    $start('2026-11-11T10:00:00+08:00');
    $r = $http('GET', '/api/health');
    $expect('health', $r, 200);
    $check('security headers', ($r['headers']['x-content-type-options'] ?? '') === 'nosniff'
        && ($r['headers']['x-frame-options'] ?? '') === 'DENY' && ($r['headers']['cache-control'] ?? '') === 'no-store'
        && str_contains($r['headers']['content-security-policy'] ?? '', "default-src 'self'"));
    $expect('meta without token', $http('GET', '/api/meta'), 401, 'UNAUTHORIZED');
    $check('first start created initial-admin.txt', is_file("$dataDir/initial-admin.txt"));
    preg_match('/password: (\S+)/', (string) @file_get_contents("$dataDir/initial-admin.txt"), $m);
    $adminPw = $m[1] ?? '';
    $check('random 12-char admin password', strlen($adminPw) === 12);
    $check('admin password printed to the server console', str_contains((string) file_get_contents($logFile), $adminPw));
    $d = $expect('admin login', $http('POST', '/api/login', ['username' => 'admin', 'password' => $adminPw]), 200);
    $tok = $d['token'] ?? '';
    $check('must change password', ($d['user']['must_change_password'] ?? null) === true);
    $expect('meta before the change', $http('GET', '/api/meta', null, $tok), 403, 'PASSWORD_CHANGE_REQUIRED');
    $expect('me before the change', $http('GET', '/api/me', null, $tok), 200);
    $d = $expect('change password', $http('POST', '/api/me/password', ['old' => $adminPw, 'new' => 'admin-pass-1'], $tok), 200);
    $admin = $d['token'] ?? '';
    $check('initial-admin.txt deleted', !file_exists("$dataDir/initial-admin.txt"));
    $expect('old token rejected', $http('GET', '/api/me', null, $tok), 401, 'UNAUTHORIZED');
    $meta = $expect('meta', $http('GET', '/api/meta', null, $admin), 200);
    $check('meta today/day_ends_at', ($meta['today'] ?? '') === '2026-11-11' && ($meta['day_ends_at'] ?? '') === '2026-11-12T04:00:00+08:00',
        json_encode($meta));
    $d = $expect('language switch', $http('PATCH', '/api/me', ['lang' => 'en'], $admin), 200);
    $check('lang stored', ($d['lang'] ?? '') === 'en');

    // ---- users ---------------------------------------------------------------------------
    $expect('create office user', $http('POST', '/api/users', ['username' => 'mei', 'name' => 'Mei', 'role' => 'office', 'lang' => 'zh', 'password' => 'mei-pass-1'], $admin), 201);
    $expect('create driver', $http('POST', '/api/users', ['username' => 'ali', 'name' => 'Ali', 'role' => 'driver', 'lang' => 'en', 'password' => 'ali-pass-1'], $admin), 201);
    $expect('duplicate username', $http('POST', '/api/users', ['username' => 'ALI', 'name' => 'A', 'role' => 'driver', 'password' => 'ali-pass-1'], $admin), 422, 'USERNAME_TAKEN');
    $login = static function (string $u, string $first, string $final) use ($http): string {
        $t = $http('POST', '/api/login', ['username' => $u, 'password' => $first])['json']['data']['token'] ?? '';
        return $http('POST', '/api/me/password', ['old' => $first, 'new' => $final], $t)['json']['data']['token'] ?? '';
    };
    $mei = $login('mei', 'mei-pass-1', 'mei-pass-2');
    $ali = $login('ali', 'ali-pass-1', 'ali-pass-2');
    $check('office and driver signed in', $mei !== '' && $ali !== '');

    // ---- M2 master data ------------------------------------------------------------------
    $a = $expect('customer A (REL)', $http('POST', '/api/customers', ['name' => 'Customer A', 'address' => '1 A Rd', 'waste_types' => ['REL']], $mei), 201);
    $b = $expect('customer B (REL + OTC)', $http('POST', '/api/customers', ['name' => 'Customer B', 'waste_types' => ['OTC', 'REL']], $mei), 201);
    $expect('customer C (COMPACTOR)', $http('POST', '/api/customers', ['name' => 'Customer C', 'waste_types' => ['COMPACTOR']], $mei), 201);
    $check('codes generated, types in order', ($a['code'] ?? '') === 'C0001' && ($b['waste_types'] ?? []) === ['REL', 'OTC']);
    $list = $expect('routable customers', $http('GET', '/api/customers?routable=1', null, $mei), 200);
    $check('routable = A and B', array_column($list ?? [], 'name') === ['Customer A', 'Customer B']);
    $expect('waste types required', $http('POST', '/api/customers', ['name' => 'X', 'waste_types' => []], $mei), 422, 'WASTE_TYPES_REQUIRED');
    $expect('trucks', $http('PUT', '/api/trucks', ['trucks' => [['plate' => 'sba 1234x', 'active' => true], ['plate' => 'GBA1234X', 'active' => true]]], $mei), 200);
    $m2 = $expect('driver reads meta', $http('GET', '/api/meta', null, $ali), 200);
    $check('driver sees the plates', ($m2['trucks'] ?? []) === ['SBA1234X', 'GBA1234X']);
    $expect('driver cannot read customers', $http('GET', '/api/customers', null, $ali), 403, 'FORBIDDEN');
    $expect('add a test holiday', $http('PUT', '/api/holidays/2026-11-20', ['name' => 'Test Holiday'], $mei), 201);
    $expect('past holiday locked', $http('DELETE', '/api/holidays/2026-11-09', null, $mei), 422, 'PAST_DATE_LOCKED');
    $h = $expect('holidays 2027', $http('GET', '/api/holidays?year=2027', null, $mei), 200);
    $check('2027 seed present', count($h ?? []) === 12);
    $expect('new waste type (admin)', $http('POST', '/api/waste-types', ['code' => 'GLS', 'name' => 'Glass'], $admin), 201);
    $expect('waste type write is admin only', $http('PATCH', '/api/waste-types/GLS', ['active' => false], $mei), 403, 'FORBIDDEN');
    $expect('office reads the rollover hour', $http('GET', '/api/settings', null, $mei), 200);
    $expect('office cannot change it', $http('PATCH', '/api/settings', ['rollover_hour' => 5], $mei), 403, 'FORBIDDEN');
    $expect('admin sets 05:00', $http('PATCH', '/api/settings', ['rollover_hour' => 5], $admin), 200);
    $expect('admin sets 04:00 again', $http('PATCH', '/api/settings', ['rollover_hour' => 4], $admin), 200);
    $dr = $expect('drivers list', $http('GET', '/api/drivers', null, $mei), 200);
    $check('drivers list has Ali', ($dr[0]['name'] ?? '') === 'Ali' && array_key_exists('route_job', $dr[0] ?? []) && $dr[0]['route_job'] === null);

    // ---- M3-M5 plan: routes, calendar (Plan part) -----------------------------------------
    $cA = (int) ($a['id'] ?? 0);
    $cB = (int) ($b['id'] ?? 0);
    $cC = $cB + 1; // customer C (COMPACTOR only)
    $st = static fn (int ...$ids) => array_map(static fn ($id) => ['customer_id' => $id, 'note' => ''], $ids);
    $n1 = $expect('create regular route N1 (Mon Wed Fri)', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'regular', 'code' => 'n1', 'name' => 'North 1',
        'start' => '2026-11-11', 'days' => [5, 1, 3], 'stops' => $st($cA, $cB)], $mei), 201);
    $check('code upper-cased, days sorted, colour auto', ($n1['code'] ?? '') === 'N1' && ($n1['days'] ?? []) === [1, 3, 5] && ($n1['color'] ?? 0) === 1);
    $expect('regular on Sunday refused', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'regular', 'code' => 'N2', 'name' => 'x',
        'start' => '2026-11-11', 'days' => [7], 'stops' => []], $mei), 422, 'WEEKDAY_NOT_ALLOWED');
    $expect('special S1 every Sunday + PH', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'special', 'code' => 'S1', 'name' => 'Sunday',
        'start' => '2026-11-15', 'sun' => true, 'ph' => true, 'stops' => $st($cA)], $mei), 201);
    $expect('adhoc on a Sunday refused', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'adhoc', 'code' => 'A9', 'name' => 'x',
        'date' => '2026-11-15', 'stops' => []], $mei), 422, 'DAY_CLASS_VIOLATION');
    $sg = $expect('suggest an adhoc code', $http('GET', '/api/routes/suggest-code?type=adhoc&date=2026-11-12', null, $mei), 200);
    $check('A1 suggested for a work day', ($sg['code'] ?? '') === 'A1' && ($sg['type'] ?? '') === 'adhoc' && ($sg['class'] ?? '') === 'work');
    $expect('urgent adhoc A1 tomorrow', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'adhoc', 'code' => 'A1', 'name' => 'Adhoc 12 Nov',
        'date' => '2026-11-12', 'stops' => $st($cB)], $mei), 201);
    $expect('COMPACTOR-only customer is not routable', $http('POST', '/api/routes', ['waste_type' => 'REL', 'type' => 'adhoc', 'code' => 'A2', 'name' => 'x',
        'date' => '2026-11-12', 'stops' => $st($cC)], $mei), 422, 'CUSTOMER_NOT_ROUTABLE');
    $expect('a route needs its waste type', $http('POST', '/api/routes', ['type' => 'adhoc', 'code' => 'A2', 'name' => 'x',
        'date' => '2026-11-12', 'stops' => []], $mei), 422, 'VALIDATION');
    $expect('OTC is never a route type', $http('POST', '/api/routes', ['waste_type' => 'OTC', 'type' => 'adhoc', 'code' => 'A2', 'name' => 'x',
        'date' => '2026-11-12', 'stops' => $st($cB)], $mei), 422, 'TYPE_NOT_ROUTABLE');
    $expect('a RECYCLING route refuses a customer without RECYCLING', $http('POST', '/api/routes', ['waste_type' => 'RECYCLING', 'type' => 'adhoc', 'code' => 'A2',
        'name' => 'x', 'date' => '2026-11-12', 'stops' => $st($cA)], $mei), 422, 'CUSTOMER_NOT_ROUTABLE');
    $expect('customer A also registers RECYCLING', $http('PATCH', "/api/customers/$cA", ['waste_types' => ['REL', 'RECYCLING']], $mei), 200);
    $rc = $expect('RECYCLING route R1 (Tue Thu)', $http('POST', '/api/routes', ['waste_type' => 'RECYCLING', 'type' => 'regular', 'code' => 'R1', 'name' => 'Recycling 1',
        'start' => '2026-11-12', 'days' => [2, 4], 'stops' => $st($cA)], $mei), 201);
    $check('the route keeps its waste type', ($rc['waste_type'] ?? '') === 'RECYCLING' && ($n1['waste_type'] ?? '') === 'REL');
    $expect('the waste type of a route never changes', $http('PATCH', '/api/routes/' . ($rc['id'] ?? 0), ['rev' => 1, 'waste_type' => 'REL'], $mei), 422, 'TYPE_IMMUTABLE');
    $expect('RECYCLING is in use by R1', $http('PATCH', '/api/waste-types/RECYCLING', ['active' => false], $admin), 409, 'WASTE_TYPE_IN_USE');
    $expect('the task endpoints are gone', $http('POST', '/api/tasks', ['waste_type' => 'OTC', 'customer_id' => $cB, 'date' => '2026-11-15'], $mei), 404, 'NOT_FOUND');
    $expect('... also the list', $http('GET', '/api/tasks', null, $mei), 404, 'NOT_FOUND');
    $dc = $expect('driver reads the customers for free submissions', $http('GET', '/api/driver/customers', null, $ali), 200);
    $check('B (OTC) and C (COMPACTOR), without their routable types', array_column($dc ?? [], 'waste_types', 'name') === ['Customer B' => ['OTC'], 'Customer C' => ['COMPACTOR']],
        json_encode($dc));
    $wk = $expect('calendar week', $http('GET', '/api/calendar?view=week&anchor=2026-11-11', null, $mei), 200);
    $todayN1 = array_values(array_filter($wk['routes'] ?? [], static fn ($o) => $o['key'] === 'r1@2026-11-11'))[0] ?? [];
    $check('calendar: 7 days, N1 today not started with 2 stops', count($wk['days'] ?? []) === 7
        && ($todayN1['run_status'] ?? '') === 'not_started' && count($todayN1['stops'] ?? []) === 2, json_encode($todayN1));
    $ph = $expect('calendar on the test PH', $http('GET', '/api/calendar?view=week&anchor=2026-11-20', null, $mei), 200);
    $fri = array_values(array_filter($ph['routes'] ?? [], static fn ($o) => $o['date'] === '2026-11-20'));
    $check('Fri PH: S1 runs, N1 paused (listed last); the calendar has no tasks', array_column($fri, 'code') === ['S1', 'N1']
        && ($fri[1]['status'] ?? '') === 'holiday_skipped' && ($fri[0]['waste_type'] ?? '') === 'REL'
        && is_array($ph) && !array_key_exists('tasks', $ph)
        && !in_array('task', array_merge(...array_column($ph['days'] ?? [], 'can_create')), true), json_encode($fri));
    $cp = $expect('move the paused N1 to Saturday', $http('POST', '/api/routes/1/dates/2026-11-20/copy', ['rev' => 1, 'to' => '2026-11-21'], $mei), 201);
    $check('copy keeps type regular (R tag), code N1-21', ($cp['created']['type'] ?? '') === 'regular' && ($cp['created']['code'] ?? '') === 'N1-21');
    $ed = $expect('only this date: drop customer B on Fri 13 Nov', $http('PUT', '/api/routes/1/dates/2026-11-13',
        ['rev' => 1, 'scope' => 'this', 'stops' => $st($cA)], $mei), 200);
    $check('occurrence edited, route rev 2', ($ed['occurrence']['edited'] ?? null) === true && ($ed['route']['rev'] ?? 0) === 2);
    $expect('stale rev refused', $http('PATCH', '/api/routes/1', ['rev' => 1, 'name' => 'x'], $mei), 409, 'STALE_REVISION');
    $expect('driver cannot read the calendar', $http('GET', '/api/calendar', null, $ali), 403, 'FORBIDDEN');

    // ---- lockout ----------------------------------------------------------------------
    for ($i = 1; $i <= 4; $i++) {
        $http('POST', '/api/login', ['username' => 'ali', 'password' => "bad-$i"]);
    }
    $r = $http('POST', '/api/login', ['username' => 'ali', 'password' => 'bad-5']);
    $expect('5th wrong password locks', $r, 423, 'ACCOUNT_LOCKED');
    $check('lock until +10 min', ($r['json']['error']['details']['until'] ?? '') === '2026-11-11T10:10:00+08:00', $r['body']);
    $expect('admin reset clears the lock', $http('PATCH', '/api/users/3', ['password' => 'ali-reset-1'], $admin), 200);
    $expect('login after reset', $http('POST', '/api/login', ['username' => 'ali', 'password' => 'ali-reset-1']), 200);

    // ---- R1 rollover over real HTTP (server restarted with another fake_now) ----------
    $start('2026-11-12T03:59:00+08:00');
    $m3 = $expect('meta at 03:59', $http('GET', '/api/meta', null, $mei), 200);
    $check('03:59 is still Wed 11 Nov', ($m3['today'] ?? '') === '2026-11-11' && ($m3['now'] ?? '') === '2026-11-12T03:59:00+08:00', json_encode($m3));
    $expect('night-shift plan edit on Wed at 03:59', $http('PUT', '/api/holidays/2026-11-11', ['name' => 'Night test'], $mei), 201);
    $start('2026-11-12T04:00:00+08:00');
    $m4 = $expect('meta at 04:00', $http('GET', '/api/meta', null, $mei), 200);
    $check('04:00 is Thu 12 Nov', ($m4['today'] ?? '') === '2026-11-12' && ($m4['day_ends_at'] ?? '') === '2026-11-13T04:00:00+08:00');
    $expect('Wed is locked at 04:00', $http('DELETE', '/api/holidays/2026-11-11', null, $mei), 422, 'PAST_DATE_LOCKED');
    $c4 = $expect('calendar after the rollover', $http('GET', '/api/calendar?view=week&anchor=2026-11-12', null, $mei), 200);
    $wedDay = array_values(array_filter($c4['days'] ?? [], static fn ($d) => $d['date'] === '2026-11-11'))[0] ?? [];
    $wedN1 = array_values(array_filter($c4['routes'] ?? [], static fn ($o) => $o['key'] === 'r1@2026-11-11'))[0] ?? [];
    $thuA1 = array_values(array_filter($c4['routes'] ?? [], static fn ($o) => $o['key'] === 'r3@2026-11-12'))[0] ?? [];
    $check('Wed frozen (past, read-only, N1 paused by the night-shift PH), Thu A1 not started',
        ($wedDay['past'] ?? null) === true && ($wedDay['can_create'] ?? null) === [] && ($wedN1['frozen'] ?? null) === true
        && ($wedN1['status'] ?? '') === 'holiday_skipped' && ($thuA1['run_status'] ?? '') === 'not_started', json_encode([$wedDay, $wedN1, $thuA1]));
    $check('day file of Wed has the frozen plan', is_array(json_decode((string) @file_get_contents("$dataDir/days/2026-11-11.json"), true)['plan'] ?? null));
    $expect('Wed plan write locked', $http('PUT', '/api/routes/1/dates/2026-11-11', ['rev' => 2, 'scope' => 'this', 'note' => 'x'], $mei), 422, 'PAST_DATE_LOCKED');

    // fake_now is ignored without the .demo marker
    unlink("$dataDir/.demo");
    $start('2001-01-01T10:00:00+08:00');
    $r5 = $http('GET', '/api/meta', null, $mei);
    // R13: while the real clock is behind frozen_through (2026-11-11 after the 04:00 step) the answer is
    // 503 CLOCK_BEHIND_FREEZE; with a later real clock it is 200. Either way the 2001 fake_now must be ignored.
    $today5 = (string) ($r5['status'] === 503 ? ($r5['json']['error']['details']['today'] ?? '') : ($r5['json']['data']['today'] ?? ''));
    $check('meta without .demo', $r5['status'] === 200 || ($r5['json']['error']['code'] ?? '') === 'CLOCK_BEHIND_FREEZE', $r5['body']);
    $check('fake_now ignored without .demo', $today5 !== '' && !str_starts_with($today5, '2001'), json_encode($today5));
    touch("$dataDir/.demo");

    // ---- audit, SPA fallback, errors --------------------------------------------------
    $audit = (string) @file_get_contents("$dataDir/audit/2026-11.jsonl");
    $check('audit log written', substr_count($audit, "\n") >= 20);
    $check('no passwords in the audit log', !str_contains($audit, 'mei-pass') && !str_contains($audit, 'admin-pass-1') && !str_contains($audit, $adminPw));
    $r = $http('GET', '/driver');
    $check('SPA fallback for /driver', ($r['status'] === 200 && str_contains($r['headers']['content-type'] ?? '', 'text/html'))
        || ($r['status'] === 404 && str_contains($r['body'], 'not built')), "{$r['status']} {$r['body']}");
    $expect('unknown api path', $http('GET', '/api/nope', null, $mei), 404, 'NOT_FOUND');
    $expect('malformed JSON body', $http('POST', '/api/login', '{"username":'), 400, 'VALIDATION');
    $plan = json_decode((string) file_get_contents("$dataDir/plan.json"), true);
    $check('plan.json valid with .bak', is_array($plan) && is_array(json_decode((string) file_get_contents("$dataDir/plan.json.bak"), true)));

    // ---- M6-M8 runs, driver API, results, files (§13 api_smoke steps 3-10) ---------------------------
    // A fresh data dir (wiped, .demo) seeded with known users so the scripted day starts from a clean Wed.
    $stop();
    $rmrf($dataDir);
    mkdir("$dataDir/days", 0777, true);
    touch("$dataDir/.demo");
    $seedPlan = Seed::plan('2026-11-11', $config['seed_file']);
    $seedPlan['trucks'] = [['plate' => 'SBA1234X', 'active' => true], ['plate' => 'GBA1234X', 'active' => true]];
    $seedPlan['customers'] = [];
    foreach ([[1, 'Kopi Tiam 88', ['REL']], [2, 'ABC Restaurant', ['REL', 'OTC']], [3, 'Sin Hup', ['REL']], [4, 'Golden Bakery', ['REL']]] as [$id, $nm, $wt]) {
        $seedPlan['customers'][] = ['id' => $id, 'code' => sprintf('C%04d', $id), 'name' => $nm, 'address' => "$id Smoke Rd", 'phone' => '', 'note' => '',
            'waste_types' => $wt, 'active' => true];
    }
    $stp = static fn (int ...$ids) => array_map(static fn ($id) => ['customer_id' => $id, 'note' => ''], $ids);
    $seedPlan['routes'] = [
        ['id' => 1, 'code' => 'N1', 'color' => 1, 'type' => 'regular', 'name' => 'North 1', 'note' => '', 'rev' => 1, 'start' => '2026-11-02', 'end' => null,
            'days' => [1, 3, 5], 'stops' => $stp(1, 2)],
        ['id' => 2, 'code' => 'A2', 'color' => 2, 'type' => 'adhoc', 'name' => 'Adhoc 11 Nov', 'note' => '', 'rev' => 1, 'date' => '2026-11-11',
            'copied_from' => null, 'stops' => $stp(4, 3)],
        ['id' => 3, 'code' => 'A3', 'color' => 3, 'type' => 'adhoc', 'name' => 'Never claimed', 'note' => '', 'rev' => 1, 'date' => '2026-11-11',
            'copied_from' => null, 'stops' => $stp(2)],
    ];
    $seedPlan['seq'] = ['customer' => 4, 'route' => 3];
    $pwHash = password_hash('smoke-pass-1', PASSWORD_BCRYPT, ['cost' => 4]);
    $seedUsers = [];
    foreach ([[1, 'admin', 'admin'], [2, 'mei', 'office'], [3, 'ali', 'driver'], [4, 'bala', 'driver']] as [$id, $un, $role]) {
        $seedUsers[] = ['id' => $id, 'username' => $un, 'name' => ucfirst($un), 'role' => $role, 'lang' => 'en', 'password_hash' => $pwHash,
            'must_change_password' => false, 'active' => true, 'token_version' => 1, 'failed_logins' => []];
    }
    file_put_contents("$dataDir/plan.json", FileStore::encodeDoc($seedPlan));
    file_put_contents("$dataDir/users.json", FileStore::encodeDoc(['seq' => 4, 'users' => $seedUsers]));
    file_put_contents("$dataDir/secret.key", bin2hex(random_bytes(32)) . "\n");
    $start('2026-11-11T07:30:00+08:00');
    $tok = static fn (string $u) => $http('POST', '/api/login', ['username' => $u, 'password' => 'smoke-pass-1'])['json']['data']['token'] ?? '';
    [$mei, $ali, $bala, $admin] = [$tok('mei'), $tok('ali'), $tok('bala'), $tok('admin')];
    $check('runs: office and two drivers signed in', $mei !== '' && $ali !== '' && $bala !== '');
    $W = '/api/driver/runs/2026-11-11';
    $O = '/api/runs/2026-11-11';
    $op = static fn (int $n) => sprintf('5a0c0000-0000-4000-8000-%012d', $n);
    $visitBody = static fn (int $n, int $base, array $w, array $extra = []) => array_merge(['op_id' => $op($n), 'base_rev' => $base, 'outcome' => 'collected',
        'weights' => $w, 'tickets' => (object) [], 'photos' => [], 'signature' => null, 'reason' => null, 'note' => '', 'captured_at' => null], $extra);

    // 3. two drivers race to claim N1: the first confirm wins (the parallel version is tests/race.php)
    $t = $expect('runs: driver today', $http('GET', '/api/driver/today', null, $ali), 200);
    $check('runs: today lists N1, A2, A3 not started', array_column($t['routes'] ?? [], 'code') === ['A2', 'A3', 'N1']
        && array_unique(array_column($t['routes'] ?? [], 'status')) === ['not_started'], json_encode($t['routes'] ?? null));
    $c1 = $expect('runs: Ali confirms N1', $http('POST', "$W/r1/claim", ['vehicle_no' => 'sba1234x'], $ali), 201);
    $check('runs: claim returns the JobDetail', ($c1['run']['mine'] ?? null) === true && ($c1['run']['vehicle_no'] ?? '') === 'SBA1234X');
    $r = $http('POST', "$W/r1/claim", ['vehicle_no' => 'GBA1234X'], $bala);
    $expect('runs: Bala gets RUN_TAKEN', $r, 409, 'RUN_TAKEN');
    $check('runs: RUN_TAKEN names the holder', ($r['json']['error']['details']['driver'] ?? '') === 'Ali', $r['body']);

    // 4. results with a photo and a signature uploaded first (raw PUT through php -S)
    $photo = '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg';
    $sig = '5d2a0000-1111-4222-8333-444455556666.png';
    $jpeg = "\xFF\xD8\xFF\xE0" . random_bytes(3000);
    $up = static function (string $name, string $bytes, string $type, string $token) use ($base): array {
        $ch = curl_init("$base/api/files/$name");
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => 'PUT', CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => $bytes,
            CURLOPT_HTTPHEADER => ["Content-Type: $type", "Authorization: Bearer $token"], CURLOPT_TIMEOUT => 10]);
        $out = (string) curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'json' => json_decode($out, true), 'body' => $out, 'headers' => []];
    };
    $expect('runs: upload a photo (raw jpg)', $up($photo, $jpeg, 'image/jpeg', $ali), 201);
    $expect('runs: the same upload again is 200', $up($photo, $jpeg, 'image/jpeg', $ali), 200);
    $expect('runs: upload a signature (png)', $up($sig, "\x89PNG\r\n\x1A\n" . random_bytes(200), 'image/png', $ali), 201);
    $expect('runs: a png over 300 KB is refused', $up('5d2a0000-1111-4222-8333-444455556667.png', "\x89PNG" . str_repeat('x', 300001), 'image/png', $ali), 413, 'FILE_TOO_LARGE');
    $expect('runs: a fake jpg is refused', $up('5d2a0000-1111-4222-8333-444455556668.jpg', 'GIF89a', 'image/jpeg', $ali), 422, 'FILE_INVALID');
    $g = $http('GET', "/api/files/$photo", null, $mei);
    $check('runs: the office downloads the same bytes', $g['status'] === 200 && $g['body'] === $jpeg
        && ($g['headers']['content-type'] ?? '') === 'image/jpeg' && str_contains($g['headers']['cache-control'] ?? '', 'immutable'));
    $expect('runs: files need a token', $http('GET', "/api/files/$photo"), 401, 'UNAUTHORIZED');
    $v = $expect('runs: Ali collects Kopi Tiam (photo + signature)', $http('PUT', "$W/r1/stops/1", $visitBody(1, 0, ['REL' => '120,5'],
        ['photos' => [$photo], 'signature' => $sig, 'captured_at' => '2026-11-11T07:29:00+08:00']), $ali), 200);
    $check('runs: visit stored with the file paths', ($v['visit']['photos'] ?? []) === ["files/0b/$photo"] && ($v['visit']['weights']['REL'] ?? 0) == 120.5
        && ($v['progress']['pending'] ?? 0) === 1, json_encode($v));
    $v = $expect('runs: the outbox resends the same op_id', $http('PUT', "$W/r1/stops/1", $visitBody(1, 0, ['REL' => '120,5'], ['photos' => [$photo], 'signature' => $sig]), $ali), 200);
    $check('runs: replay applied once', ($v['replay'] ?? null) === true && ($v['visit']['rev'] ?? 0) === 1);
    $expect('runs: OTC is never weighed on a route', $http('PUT', "$W/r1/stops/2", $visitBody(2, 0, ['OTC' => 5]), $ali), 422, 'TYPE_NOT_ALLOWED');
    $expect('runs: a file must be uploaded first', $http('PUT', "$W/r1/stops/2", $visitBody(3, 0, ['REL' => 5],
        ['photos' => ['0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f2.jpg']]), $ali), 422, 'FILE_MISSING');

    // 5. switch route midway: N1's remaining stop goes back to Needs driver
    $expect('runs: a second route needs switch', $http('POST', "$W/r2/claim", ['vehicle_no' => 'SBA1234X'], $ali), 409, 'DRIVER_HAS_ACTIVE_RUN');
    $sw = $expect('runs: Ali switches to A2', $http('POST', "$W/r2/claim", ['vehicle_no' => 'SBA1234X', 'switch' => true], $ali), 201);
    $check('runs: N1 left open', ($sw['left'] ?? null) === ['job' => 'r1', 'result' => 'open'], json_encode($sw['left'] ?? null));
    $cal = $expect('runs: calendar after the switch', $http('GET', '/api/calendar?view=week&anchor=2026-11-11', null, $mei), 200);
    $occ = static fn (array $cal, string $key) => array_values(array_filter($cal['routes'] ?? [], static fn ($o) => $o['key'] === $key))[0] ?? [];
    $check('runs: the office sees N1 Needs driver (open, left by Ali) and A2 active', ($occ($cal, 'r1@2026-11-11')['run_status'] ?? '') === 'open'
        && ($occ($cal, 'r1@2026-11-11')['run']['left_by'] ?? '') === 'Ali' && ($occ($cal, 'r2@2026-11-11')['run_status'] ?? '') === 'active');

    // 6. office adds a stop to today's N1 and removes the pending one; Bala picks N1 up
    $expect('runs: office edits today only (add Sin Hup, remove ABC)', $http('PUT', '/api/routes/1/dates/2026-11-11',
        ['rev' => 1, 'scope' => 'this', 'stops' => $stp(1, 3)], $mei), 200);
    $expect('runs: Bala takes the open N1', $http('POST', "$W/r1/claim", ['vehicle_no' => 'GBA1234X'], $bala), 200);
    $j = $expect('runs: Bala sees the new stop list', $http('GET', "$W/r1", null, $bala), 200);
    $check('runs: N1 now Kopi Tiam (done by Ali) + Sin Hup (new)', array_map(static fn ($s) => $s['customer']['name'], $j['stops'] ?? []) === ['Kopi Tiam 88', 'Sin Hup']
        && ($j['stops'][0]['visit']['driver_id'] ?? null) === 3 && ($j['mine'] ?? null) === true, json_encode($j['stops'] ?? null));
    $v = $http('PUT', "$W/r1/stops/2", $visitBody(4, 0, ['REL' => 9]), $ali);
    $expect('runs: Ali\'s queued write for the removed stop is kept', $v, 200);
    $check('runs: ... as OFF_PLAN and LATE (Ali no longer holds N1)', array_column($v['json']['warnings'] ?? [], 'code') === ['OFF_PLAN', 'LATE'], $v['body']);

    // 7. a free OTC submission by Ali while he holds A2: no task, no claim; resend, correction, delete, office list
    $S = '/api/driver/submissions/2026-11-11';
    $sid = $op(900);
    $subBody = static fn (int $n, int $base, array $w, array $extra = []) => array_merge(['op_id' => $op($n), 'base_rev' => $base, 'waste_type' => 'OTC',
        'customer_id' => 2, 'vehicle_no' => 'sba 1234x', 'outcome' => 'collected', 'weights' => $w, 'tickets' => (object) [], 'photos' => [], 'signature' => null,
        'note' => 'sofa', 'captured_at' => null], $extra);
    $expect('runs: the task endpoints are gone', $http('POST', '/api/tasks', ['waste_type' => 'OTC', 'customer_id' => 2, 'date' => '2026-11-11', 'note' => 'sofa'], $mei), 404, 'NOT_FOUND');
    $expect('runs: a task job cannot be claimed', $http('POST', "$W/t1/claim", ['vehicle_no' => 'SBA1234X'], $ali), 404, 'NOT_FOUND');
    $dc = $expect('runs: the customers Ali can submit for', $http('GET', '/api/driver/customers', null, $ali), 200);
    $check('runs: only ABC Restaurant, with OTC', array_column($dc ?? [], 'waste_types', 'name') === ['ABC Restaurant' => ['OTC']], json_encode($dc));
    $expect('runs: REL is never submitted freely', $http('PUT', "$S/$sid", $subBody(5, 0, ['REL' => 3], ['waste_type' => 'REL']), $ali), 422, 'TYPE_ROUTABLE');
    $expect('runs: a customer without OTC is refused', $http('PUT', "$S/$sid", $subBody(5, 0, ['OTC' => 3], ['customer_id' => 1]), $ali), 422, 'CUSTOMER_LACKS_TYPE');
    $expect('runs: a submission needs a plate', $http('PUT', "$S/$sid", $subBody(5, 0, ['OTC' => 3], ['vehicle_no' => null]), $ali), 422, 'VEHICLE_REQUIRED');
    $expect('runs: the office cannot submit', $http('PUT', "$S/$sid", $subBody(5, 0, ['OTC' => 3]), $mei), 403, 'FORBIDDEN');
    $sv = $expect('runs: Ali submits OTC for ABC Restaurant', $http('PUT', "$S/$sid", $subBody(5, 0, ['OTC' => '300,5'], ['photos' => [$photo]]), $ali), 201);
    $check('runs: the submission is stored with type, customer snapshot, plate and photo', ($sv['submission']['waste_type'] ?? '') === 'OTC'
        && ($sv['submission']['customer']['name'] ?? '') === 'ABC Restaurant' && ($sv['submission']['vehicle_no'] ?? '') === 'SBA1234X'
        && ($sv['submission']['photos'] ?? []) === ["files/0b/$photo"] && ($sv['submission']['weights']['OTC'] ?? 0) == 300.5
        && ($sv['submission']['rev'] ?? 0) === 1 && ($sv['replay'] ?? null) === false, json_encode($sv));
    $sv = $expect('runs: the outbox resends the same submission', $http('PUT', "$S/$sid", $subBody(5, 0, ['OTC' => '300,5'], ['photos' => [$photo]]), $ali), 200);
    $check('runs: the resend is a replay, still one record', ($sv['replay'] ?? null) === true && ($sv['submission']['rev'] ?? 0) === 1);
    $sv = $expect('runs: Ali corrects the weight', $http('PUT', "$S/$sid", $subBody(6, 1, ['OTC' => 300]), $ali), 200);
    $check('runs: the correction is rev 2', ($sv['submission']['rev'] ?? 0) === 2 && ($sv['submission']['weights']['OTC'] ?? 0) == 300.0);
    $expect('runs: the type of a submission cannot change', $http('PUT', "$S/$sid", $subBody(30, 2, ['COMPACTOR' => 3], ['waste_type' => 'COMPACTOR']), $ali), 422, 'VALIDATION');
    $expect('runs: Bala cannot change Ali\'s submission', $http('PUT', "$S/$sid", $subBody(31, 2, ['OTC' => 1]), $bala), 404, 'NOT_FOUND');
    $expect('runs: tomorrow is refused', $http('PUT', '/api/driver/submissions/2026-11-12/' . $op(902), $subBody(32, 0, ['OTC' => 1]), $ali), 422, 'NOT_TODAY');
    $expect('runs: a second submission', $http('PUT', "$S/" . $op(901), $subBody(33, 0, ['OTC' => 12]), $ali), 201);
    $dl = $expect('runs: ... deleted again', $http('PUT', "$S/" . $op(901), ['op_id' => $op(34), 'base_rev' => 1, 'outcome' => null], $ali), 200);
    $check('runs: a deleted submission has no outcome', is_array($dl['submission'] ?? null) && array_key_exists('outcome', $dl['submission']) && $dl['submission']['outcome'] === null
        && ($dl['submission']['rev'] ?? 0) === 2);
    $ml = $expect('runs: Ali\'s submissions today', $http('GET', '/api/driver/submissions', null, $ali), 200);
    $check('runs: one live submission, Bala has none', array_column($ml['submissions'] ?? [], 'id') === [$sid]
        && ($http('GET', '/api/driver/submissions', null, $bala)['json']['data']['submissions'] ?? null) === []);
    $ol = $expect('runs: the office reads the day\'s submissions', $http('GET', '/api/submissions?date=2026-11-11', null, $mei), 200);
    $check('runs: the office sees it with the driver, the total and the history', count($ol['submissions'] ?? []) === 1
        && ($ol['submissions'][0]['driver'] ?? '') === 'Ali' && ($ol['totals']['OTC'] ?? 0) == 300.0
        && count($ol['submissions'][0]['history'] ?? []) === 1, json_encode($ol));
    $expect('runs: a driver cannot read the office list', $http('GET', '/api/submissions', null, $ali), 403, 'FORBIDDEN');
    $t = $expect('runs: driver today', $http('GET', '/api/driver/today', null, $ali), 200);
    $check('runs: Ali\'s work: A2; today has no task lists', ($t['my_route']['job'] ?? '') === 'r2' && is_array($t)
        && !array_key_exists('my_tasks', $t) && !array_key_exists('tasks', $t) && ($t['day_ends_at'] ?? '') === '2026-11-12T04:00:00+08:00');

    // 8. office corrects a weight with a reason; the driver sees it
    $expect('runs: a correction needs why', $http('PUT', "$O/r1/stops/1", $visitBody(7, 1, ['REL' => 118]), $mei), 422, 'WHY_REQUIRED');
    $v = $expect('runs: office corrects the weight', $http('PUT', "$O/r1/stops/1", $visitBody(7, 1, ['REL' => 118], ['why' => 'weighbridge recheck']), $mei), 200);
    $check('runs: OFFICE_EDITED with history', in_array('OFFICE_EDITED', $v['visit']['flags'] ?? [], true) && count($v['visit']['history'] ?? []) === 1);
    $expect('runs: a stale driver correction is refused (kept as CONFLICT)', $http('PUT', "$W/r1/stops/1", $visitBody(8, 1, ['REL' => 121]), $ali), 409, 'VISIT_CHANGED');
    $j = $expect('runs: Bala reloads N1', $http('GET', "$W/r1", null, $bala), 200);
    $check('runs: the phone shows the office value', ($j['stops'][0]['visit']['weights']['REL'] ?? 0) == 118);
    $g = $expect('runs: office job detail', $http('GET', "$O/r1", null, $mei), 200);
    $check('runs: office detail has holds and the full history', count($g['holds'] ?? []) === 2 && count($g['visits']['1']['history'] ?? []) === 2
        && in_array('CONFLICT', $g['visits']['1']['flags'] ?? [], true));

    // 9. night shift: 02:30 Thu is still Wednesday, then 03:59, then the 04:00 rollover
    $start('2026-11-12T02:30:00+08:00');
    $v = $http('PUT', "$W/r1/stops/3", $visitBody(9, 0, ['REL' => 40], ['captured_at' => '2026-11-12T02:29:00+08:00']), $bala);
    $expect('runs: 02:30 night-shift stop on Wednesday\'s N1', $v, 200);
    $check('runs: ... without LATE', ($v['json']['warnings'] ?? null) === [] && ($v['json']['data']['progress']['pending'] ?? -1) === 0, $v['body']);
    $expect('runs: Bala finishes N1', $http('POST', "$W/r1/release", ['mark_missed' => false], $bala), 200);
    $start('2026-11-12T03:59:00+08:00');
    $t = $expect('runs: driver today at 03:59', $http('GET', '/api/driver/today', null, $ali), 200);
    $check('runs: 03:59 still lists Wednesday', ($t['today'] ?? '') === '2026-11-11' && ($t['my_route']['job'] ?? '') === 'r2');
    $start('2026-11-12T04:00:00+08:00');
    $t = $expect('runs: driver today at 04:00', $http('GET', '/api/driver/today', null, $ali), 200);
    $check('runs: 04:00 shows Thursday (no Wednesday jobs)', ($t['today'] ?? '') === '2026-11-12' && array_key_exists('my_route', $t ?? []) && $t['my_route'] === null);
    $expect('runs: Wednesday is NOT_TODAY for a claim', $http('POST', "$W/r3/claim", ['vehicle_no' => 'SBA1234X'], $bala), 422, 'NOT_TODAY');
    $expect('runs: ... and for the old holder\'s leave', $http('POST', "$W/r2/release", ['mark_missed' => false], $ali), 422, 'NOT_TODAY');
    $cal = $expect('runs: calendar after the rollover', $http('GET', '/api/calendar?view=week&anchor=2026-11-11', null, $mei), 200);
    $wed = array_values(array_filter($cal['days'] ?? [], static fn ($d) => $d['date'] === '2026-11-11'))[0] ?? [];
    $check('runs: Wed N1 done, A2 incomplete, A3 no record', ($occ($cal, 'r1@2026-11-11')['run_status'] ?? '') === 'done'
        && ($occ($cal, 'r2@2026-11-11')['run_status'] ?? '') === 'incomplete' && ($occ($cal, 'r3@2026-11-11')['run_status'] ?? '') === 'no_record',
        json_encode([$occ($cal, 'r1@2026-11-11')['run_status'] ?? null, $occ($cal, 'r2@2026-11-11')['run_status'] ?? null, $occ($cal, 'r3@2026-11-11')['run_status'] ?? null]));
    $check('runs: Wednesday totals include the night shift and the OTC submission', ($wed['totals']['REL'] ?? 0) == 167.0 && ($wed['totals']['OTC'] ?? 0) == 300.0
        && ($wed['past'] ?? null) === true, json_encode($wed['totals'] ?? null));
    $v = $http('PUT', "$W/r2/stops/4", $visitBody(10, 0, ['REL' => 15], ['captured_at' => '2026-11-12T04:00:30+08:00']), $ali);
    $expect('runs: a late first result on Wednesday is accepted', $v, 200);
    $check('runs: ... with LATE', array_column($v['json']['warnings'] ?? [], 'code') === ['LATE'], $v['body']);

    // 10. close out and back-fill the past day
    $d = $expect('runs: office closes out A2', $http('POST', "$O/r2/release", ['mark_missed' => true], $mei), 200);
    $check('runs: A2 done', ($d['result'] ?? '') === 'done');
    $expect('runs: office back-fills A3 (done on paper)', $http('PUT', "$O/r3/stops/2", $visitBody(11, 0, ['REL' => 22], ['driver_id' => 4]), $mei), 200);
    $cal = $expect('runs: calendar after close-out', $http('GET', '/api/calendar?view=week&anchor=2026-11-11', null, $mei), 200);
    $wed = array_values(array_filter($cal['days'] ?? [], static fn ($d) => $d['date'] === '2026-11-11'))[0] ?? [];
    $check('runs: every Wednesday job is done', ($wed['ops']['done'] ?? 0) === 3 && ($wed['ops']['incomplete'] ?? 1) === 0 && ($wed['ops']['no_record'] ?? 1) === 0,
        json_encode($wed['ops'] ?? null));
    $dayDoc = json_decode((string) file_get_contents("$dataDir/days/2026-11-11.json"), true);
    $check('runs: the Wednesday day file has the frozen plan and 3 runs', is_array($dayDoc['plan'] ?? null) && count($dayDoc['runs'] ?? []) === 3);
    $check('runs: ... and both submissions (the deleted one is kept with no outcome)', count($dayDoc['submissions'] ?? []) === 2
        && array_key_exists('outcome', $dayDoc['submissions'][$op(901)] ?? []) && $dayDoc['submissions'][$op(901)]['outcome'] === null
        && ($dayDoc['submissions'][$sid]['weights']['OTC'] ?? 0) == 300);
    $ol = $expect('runs: the office still reads Wednesday\'s submissions after the rollover', $http('GET', '/api/submissions?date=2026-11-11', null, $mei), 200);
    $check('runs: ... with today = Thursday', ($ol['today'] ?? '') === '2026-11-12' && ($ol['date'] ?? '') === '2026-11-11' && count($ol['submissions'] ?? []) === 1);
    $check('runs: the photo is on disk', is_file("$dataDir/files/0b/$photo"));
    $audit = (string) @file_get_contents("$dataDir/audit/2026-11.jsonl");
    $check('runs: claims and results are in the audit log', str_contains($audit, '"path":"/api/driver/runs/2026-11-11/r1/claim"')
        && str_contains($audit, '"path":"/api/runs/2026-11-11/r1/stops/1"') && str_contains($audit, '"path":"/api/driver/submissions/2026-11-11/' . $sid . '"')
        && !str_contains($audit, 'smoke-pass-1'));
} catch (Throwable $e) {
    $failures[] = 'exception: ' . $e->getMessage();
    echo "  FAIL  " . get_class($e) . ': ' . $e->getMessage() . "\n";
} finally {
    $stop();
    $rmrf($docroot);
    @unlink($logFile);
}

echo "\n$passed passed, " . count($failures) . " failed\n";
if ($failures) {
    echo "FAILED:\n  - " . implode("\n  - ", $failures) . "\n";
    exit(1);
}
exit(0);
