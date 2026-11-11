<?php
// Concurrency test (§13 "Concurrency", D01 claim race): exactly one of many simultaneous claims on the same
// job wins, and every data file stays valid JSON.
//
//   php backend/tests/race.php [port=8182] [data_dir=<temp dir>] [n=10]
//
// Part 1 (CLI): n PHP processes claim the same job at the same moment through FileStore (the App driven
//   in-process, as §13 describes). They wait on a start file, so they really run in parallel.
// Part 2 (HTTP): `php -S` with PHP_CLI_SERVER_WORKERS=n (real parallel workers on Linux) receives n
//   simultaneous HTTP claims for another job; one driver fires claims for 4 routes at once (one route at a
//   time: exactly one wins); the winner sends the same result write (same op_id) n times at once (applied
//   exactly once, the rest are replays).
// The data dir is WIPED first and removed at the end; the server and its workers are always stopped.
// Exit code 0 = all passed.

$config = require __DIR__ . '/../bootstrap.php';

const RACE_NOW = '2026-11-11T10:00:00+08:00';
const RACE_DATE = '2026-11-11';

/** A token for $username as stored in $dir (signed with its secret.key, valid at RACE_NOW). */
function race_token(string $dir, string $username): string
{
    $users = json_decode((string) file_get_contents("$dir/users.json"), true);
    $u = $users['users'][Auth::indexByUsername($users, $username)];
    return Auth::issueToken($u, trim((string) file_get_contents("$dir/secret.key")), (new DateTimeImmutable(RACE_NOW))->getTimestamp(), 30);
}

// ---- child mode (part 1): one claim through FileStore, started by the parent's start file -------------
if (($argv[1] ?? '') === '--child') {
    [, , $dir, $username, $job, $go] = $argv;
    $app = App::create(array_replace($config, ['data_dir' => $dir, 'fake_now' => null]));
    $app->fixedNow = new DateTimeImmutable(RACE_NOW);
    $token = race_token($dir, $username);
    $req = new Request('POST', '/api/driver/runs/' . RACE_DATE . "/$job/claim", [], ['Authorization' => "Bearer $token"],
        json_encode(['vehicle_no' => 'SBA1234X']), '127.0.0.1');
    touch("$go.ready.$username");
    for ($i = 0; $i < 20000 && !file_exists($go); $i++) {
        usleep(500);
    }
    $resp = $app->handle($req);
    echo json_encode(['user' => $username, 'status' => $resp->status, 'code' => $resp->data()['error']['code'] ?? null]), "\n";
    exit(0);
}

$port = (int) ($argv[1] ?? 8182);
$dir = rtrim($argv[2] ?? (sys_get_temp_dir() . '/wms-race-' . getmypid()), '/');
$n = max(2, (int) ($argv[3] ?? 10));
$docroot = sys_get_temp_dir() . '/wms-race-docroot-' . getmypid();
$logFile = sys_get_temp_dir() . '/wms-race-server-' . getmypid() . '.log';

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
$validJson = static function () use ($dir): array {
    $bad = [];
    foreach (array_merge(["$dir/plan.json", "$dir/users.json"], glob("$dir/days/*.json") ?: []) as $f) {
        if (!is_array(json_decode((string) file_get_contents($f), true))) {
            $bad[] = basename($f);
        }
    }
    return $bad;
};
$day = static fn () => json_decode((string) file_get_contents("$dir/days/" . RACE_DATE . '.json'), true);

$server = null;
$stop = static function () use (&$server): void {
    if (!is_resource($server)) {
        return;
    }
    $pid = proc_get_status($server)['pid'];
    // php -S with PHP_CLI_SERVER_WORKERS forks workers: stop them as well as the parent.
    // Workers first, so the master reaps them and exits by itself; then the master if it is still there.
    @shell_exec('pkill -TERM -P ' . (int) $pid . ' 2>/dev/null');
    for ($i = 0; $i < 50 && proc_get_status($server)['running']; $i++) {
        usleep(20000);
    }
    if (proc_get_status($server)['running']) {
        proc_terminate($server, 15);
    }
    for ($i = 0; $i < 50 && proc_get_status($server)['running']; $i++) {
        usleep(20000);
    }
    if (proc_get_status($server)['running']) {
        @shell_exec('pkill -KILL -P ' . (int) $pid . ' 2>/dev/null');
        proc_terminate($server, 9);
    }
    proc_close($server);
    $server = null;
};

try {
    // ---- seed: n*2 + 1 drivers, one truck, six adhoc routes today with two stops each ------------------
    $rmrf($dir);
    mkdir("$dir/days", 0777, true);
    touch("$dir/.demo");
    $plan = Seed::plan(RACE_DATE, $config['seed_file']);
    $plan['trucks'] = [['plate' => 'SBA1234X', 'active' => true]];
    $plan['customers'] = [];
    foreach ([1, 2] as $cid) {
        $plan['customers'][] = ['id' => $cid, 'code' => sprintf('C%04d', $cid), 'name' => "Customer $cid", 'address' => '', 'phone' => '',
            'note' => '', 'waste_types' => ['REL'], 'active' => true];
    }
    $plan['routes'] = [];
    for ($r = 1; $r <= 6; $r++) {
        $plan['routes'][] = ['id' => $r, 'code' => "A$r", 'color' => $r, 'type' => 'adhoc', 'name' => "Race $r", 'note' => '', 'rev' => 1,
            'date' => RACE_DATE, 'copied_from' => null, 'stops' => [['customer_id' => 1, 'note' => ''], ['customer_id' => 2, 'note' => '']]];
    }
    $plan['seq'] = ['customer' => 2, 'route' => 6, 'task' => 0];
    $hash = password_hash('password1', PASSWORD_BCRYPT, ['cost' => 4]);
    $users = [['id' => 1, 'username' => 'admin', 'name' => 'Admin', 'role' => 'admin', 'lang' => 'en', 'password_hash' => $hash,
        'must_change_password' => false, 'active' => true, 'token_version' => 1, 'failed_logins' => []]];
    for ($i = 1; $i <= 2 * $n + 1; $i++) {
        $users[] = ['id' => $i + 1, 'username' => "d$i", 'name' => "Driver $i", 'role' => 'driver', 'lang' => 'en', 'password_hash' => $hash,
            'must_change_password' => false, 'active' => true, 'token_version' => 1, 'failed_logins' => []];
    }
    file_put_contents("$dir/plan.json", FileStore::encodeDoc($plan));
    file_put_contents("$dir/users.json", FileStore::encodeDoc(['seq' => count($users), 'users' => $users]));
    file_put_contents("$dir/secret.key", bin2hex(random_bytes(32)) . "\n");
    echo "data dir $dir, $n concurrent claims\n";

    // ---- part 1: n CLI processes through FileStore ---------------------------------------------------
    $go = "$dir/race-go";
    $kids = [];
    for ($i = 1; $i <= $n; $i++) {
        $proc = proc_open([PHP_BINARY, __FILE__, '--child', $dir, "d$i", 'r1', $go], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $kids[] = [$proc, $pipes];
    }
    for ($w = 0; $w < 2000 && count(glob("$go.ready.*") ?: []) < $n; $w++) {
        usleep(5000);
    }
    $check("all $n CLI claimers ready", count(glob("$go.ready.*") ?: []) === $n);
    touch($go); // start them all at once
    $results = [];
    foreach ($kids as [$proc, $pipes]) {
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($proc);
        $results[] = json_decode(trim((string) $out), true) ?? ['status' => 0, 'code' => 'CRASH: ' . trim($out . $err)];
    }
    $statuses = array_count_values(array_map(static fn ($r) => $r['status'] . ' ' . ($r['code'] ?? ''), $results));
    ksort($statuses);
    $check('CLI: exactly one claim wins (201), the others get 409 RUN_TAKEN',
        ($statuses['201 '] ?? 0) === 1 && ($statuses['409 RUN_TAKEN'] ?? 0) === $n - 1, json_encode($statuses));
    $run = $day()['runs']['r1'] ?? [];
    $winner = array_values(array_filter($results, static fn ($r) => $r['status'] === 201))[0]['user'] ?? '?';
    $check('CLI: the run has one hold, by the winner', count($run['holds'] ?? []) === 1
        && ($run['holds'][0]['driver_id'] ?? null) === (int) substr($winner, 1) + 1, json_encode($run));
    $check('CLI: every data file is valid JSON', $validJson() === [], implode(', ', $validJson()));
    foreach (glob("$go*") ?: [] as $f) {
        unlink($f);
    }

    // ---- part 2: real HTTP against php -S with parallel workers ----------------------------------------
    @mkdir($docroot, 0777, true);
    $env = array_merge(getenv(), ['WMS_DATA_DIR' => $dir, 'WMS_FAKE_NOW' => RACE_NOW, 'PHP_CLI_SERVER_WORKERS' => (string) $n]);
    $server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot, __DIR__ . '/../public/index.php'],
        [0 => ['file', '/dev/null', 'r'], 1 => ['file', $logFile, 'a'], 2 => ['file', $logFile, 'a']], $pipes, null, $env);
    $up = false;
    for ($i = 0; $i < 100 && !$up; $i++) {
        $fp = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
        if ($fp) {
            fclose($fp);
            $up = true;
        } else {
            usleep(50000);
        }
    }
    if (!$up) {
        throw new RuntimeException("php -S did not start on port $port (is the port free?)");
    }
    /** Sends all requests at once; @return list<array{status:int,json:mixed}> */
    $multi = static function (array $reqs) use ($port): array {
        $mh = curl_multi_init();
        $hs = [];
        foreach ($reqs as [$method, $path, $body, $token]) {
            $h = curl_init("http://127.0.0.1:$port$path");
            curl_setopt_array($h, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', "Authorization: Bearer $token"], CURLOPT_POSTFIELDS => json_encode($body)]);
            curl_multi_add_handle($mh, $h);
            $hs[] = $h;
        }
        do {
            $st = curl_multi_exec($mh, $active);
            if ($active) {
                curl_multi_select($mh, 1.0);
            }
        } while ($active && $st === CURLM_OK);
        $out = [];
        foreach ($hs as $h) {
            $out[] = ['status' => (int) curl_getinfo($h, CURLINFO_RESPONSE_CODE), 'json' => json_decode((string) curl_multi_getcontent($h), true)];
            curl_multi_remove_handle($mh, $h);
            curl_close($h);
        }
        curl_multi_close($mh);
        return $out;
    };
    $tally = static function (array $res): array {
        $t = array_count_values(array_map(static fn ($r) => $r['status'] . ' ' . ($r['json']['error']['code'] ?? ''), $res));
        ksort($t);
        return $t;
    };

    $reqs = [];
    $tokens = [];
    for ($i = $n + 1; $i <= 2 * $n; $i++) {
        $tokens[$i] = race_token($dir, "d$i");
        $reqs[] = ['POST', '/api/driver/runs/' . RACE_DATE . '/r2/claim', ['vehicle_no' => 'SBA1234X'], $tokens[$i]];
    }
    $res = $multi($reqs);
    $t = $tally($res);
    $check("HTTP: $n simultaneous claims, exactly one wins (201), the others get 409 RUN_TAKEN",
        ($t['201 '] ?? 0) === 1 && ($t['409 RUN_TAKEN'] ?? 0) === $n - 1, json_encode($t));
    $winnerIdx = array_search(201, array_column($res, 'status'), true);
    $winnerTok = $winnerIdx === false ? '' : $reqs[$winnerIdx][3];
    $check('HTTP: the run of r2 has exactly one hold', count($day()['runs']['r2']['holds'] ?? []) === 1);

    // one driver confirms four routes at the same moment: one route at a time (R23 step 6)
    $solo = race_token($dir, 'd' . (2 * $n + 1));
    $res = $multi(array_map(static fn ($r) => ['POST', '/api/driver/runs/' . RACE_DATE . "/r$r/claim", ['vehicle_no' => 'SBA1234X'], $solo], [3, 4, 5, 6]));
    $t = $tally($res);
    $held = array_filter($day()['runs'], static fn ($run) => ($run['driver_id'] ?? null) === 2 * $n + 2);
    $check('HTTP: one driver claiming 4 routes at once gets exactly one; the rest DRIVER_HAS_ACTIVE_RUN',
        ($t['201 '] ?? 0) === 1 && ($t['409 DRIVER_HAS_ACTIVE_RUN'] ?? 0) === 3 && count($held) === 1, json_encode($t));

    // the same result write (same op_id) delivered n times at once: applied once, replays for the rest
    $body = ['op_id' => '11111111-2222-4333-8444-555555555555', 'base_rev' => 0, 'outcome' => 'collected', 'weights' => ['REL' => 12.5],
        'tickets' => (object) [], 'photos' => [], 'signature' => null, 'reason' => null, 'note' => '', 'captured_at' => RACE_NOW];
    $res = $multi(array_fill(0, $n, ['PUT', '/api/driver/runs/' . RACE_DATE . '/r2/stops/1', $body, $winnerTok]));
    $replays = array_count_values(array_map(static fn ($r) => $r['status'] . ' replay=' . json_encode($r['json']['data']['replay'] ?? null), $res));
    $visit = $day()['runs']['r2']['visits']['1'] ?? [];
    $check("HTTP: the same op_id sent $n times at once is applied exactly once",
        ($replays['200 replay=false'] ?? 0) === 1 && ($replays['200 replay=true'] ?? 0) === $n - 1
        && ($visit['rev'] ?? 0) === 1 && count($visit['ops'] ?? []) === 1 && ($visit['history'] ?? null) === [], json_encode($replays));
    $check('HTTP: every data file is valid JSON', $validJson() === [], implode(', ', $validJson()));
    $check('no PHP errors in the server log', !preg_match('/PHP (Fatal|Warning|Notice)|WMS \w+Exception|WMS Error/', (string) @file_get_contents($logFile)),
        substr((string) @file_get_contents($logFile), 0, 500));
} catch (Throwable $e) {
    $failures[] = 'exception: ' . $e->getMessage();
    echo '  FAIL  ' . get_class($e) . ': ' . $e->getMessage() . "\n";
} finally {
    $stop();
    $rmrf($docroot);
    $rmrf($dir);
    @unlink($logFile);
}

echo "\n$passed passed, " . count($failures) . " failed\n";
if ($failures) {
    echo "FAILED:\n  - " . implode("\n  - ", $failures) . "\n";
    exit(1);
}
exit(0);
