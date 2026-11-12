<?php
// FileStore (R36, §4.2): first start, atomic writes, .bak, DATA_CORRUPT, secret.key recovery.
$now = '2026-11-11T10:00:00+08:00';

return [
    'first start seeds plan, users, secret and a random admin password' => function () use ($now) {
        $env = TestEnv::make($now, ['first_start' => true]);
        $seeded = [];
        $env->app->store->onSeed = function (string $pw, string $file) use (&$seeded) {
            $seeded[] = $pw;
        };
        T::err($env->call('POST', '/api/login', ['username' => 'admin', 'password' => 'wrong-pass']), 401, 'BAD_CREDENTIALS');
        T::eq(1, count($seeded), 'seeded once');
        $pw = $seeded[0];
        T::true((bool) preg_match('/^[A-Za-z0-9]{12}$/', $pw), "12-char password: $pw");
        T::true(str_contains($env->doc('file:initial-admin.txt')['content'], "password: $pw"), 'initial-admin.txt');
        $plan = $env->doc('plan');
        T::eq('2026-11-10', $plan['frozen_through']);
        T::eq([2026, 2027], $plan['seeded_years']);
        T::eq(4, $plan['settings']['rollover_hour']);
        T::eq(['REL', 'RECYCLING', 'OTC', 'COMPACTOR', 'EROSE'], array_column($plan['waste_types'], 'code'));
        T::eq(['Recycling', 'RCY', true], [$plan['waste_types'][1]['name'], $plan['waste_types'][1]['abbr'], $plan['waste_types'][1]['routable']]);
        T::eq([false, false, false], array_column(array_slice($plan['waste_types'], 2), 'routable'));
        T::eq(false, isset($plan['tasks']) || isset($plan['task_overrides']) || isset($plan['seq']['task']), 'a new install has no task keys');
        T::eq(26, count($plan['holidays']));
        T::true(is_dir($env->dir . '/days'), 'days/ created');
        T::eq(64, strlen(trim($env->doc('file:secret.key')['content'])));
        $users = $env->doc('users');
        T::subset(['seq' => 1, 'users' => [['id' => 1, 'username' => 'admin', 'role' => 'admin', 'must_change_password' => true, 'active' => true]]], $users);
        // a second request does not seed again
        T::err($env->call('POST', '/api/login', ['username' => 'admin', 'password' => 'wrong-pass']), 401, 'BAD_CREDENTIALS');
        T::eq(1, count($seeded));
        // the password works, and must be changed before anything else
        $login = T::ok($env->call('POST', '/api/login', ['username' => 'admin', 'password' => $pw]));
        T::eq(true, $login['user']['must_change_password']);
        $tok = 'token:' . $login['token'];
        T::err($env->call('GET', '/api/meta', null, $tok), 403, 'PASSWORD_CHANGE_REQUIRED');
        T::ok($env->call('GET', '/api/me', null, $tok));
        $new = T::ok($env->call('POST', '/api/me/password', ['old' => $pw, 'new' => 'brand-new-pass'], $tok));
        T::eq(false, $env->doc('file:initial-admin.txt')['exists'], 'initial-admin.txt deleted after the change');
        T::ok($env->call('GET', '/api/meta', null, 'token:' . $new['token']));
        $env->cleanup();
    },
    'two first starts get different admin passwords' => function () use ($now) {
        $pws = [];
        for ($i = 0; $i < 2; $i++) {
            $env = TestEnv::make($now, ['first_start' => true]);
            $env->app->store->onSeed = function (string $pw) use (&$pws) {
                $pws[] = $pw;
            };
            $env->call('POST', '/api/login', ['username' => 'x', 'password' => 'y']);
            $env->cleanup();
        }
        T::eq(2, count($pws));
        T::true($pws[0] !== $pws[1], 'random');
    },
    'an undecodable plan.json returns DATA_CORRUPT and writes nothing' => function () use ($now) {
        $env = TestEnv::make($now);
        file_put_contents($env->dir . '/plan.json', '{"schema": 1, broken');
        $err = T::err($env->call('POST', '/api/login', ['username' => 'ali', 'password' => 'wrong']), 503, 'DATA_CORRUPT');
        T::eq('plan.json', $err['details']['file']);
        T::eq('{"schema": 1, broken', file_get_contents($env->dir . '/plan.json'));
        T::eq(false, file_exists($env->dir . '/plan.json.bak'), 'no .bak from a corrupt file');
        T::eq([], $env->doc('users')['users'][2]['failed_logins'], 'users not written');
        $env->cleanup();
    },
    'an undecodable day file returns DATA_CORRUPT' => function () use ($now) {
        $env = TestEnv::make($now, ['files' => ['days/2026-11-11.json' => 'nope']]);
        $err = T::err($env->call('GET', '/api/drivers', null, 'mei'), 503, 'DATA_CORRUPT');
        T::eq('days/2026-11-11.json', $err['details']['file']);
        $env->cleanup();
    },
    'a missing plan with a .bak present is not a first start' => function () use ($now) {
        $env = TestEnv::make($now);
        rename($env->dir . '/plan.json', $env->dir . '/plan.json.bak');
        $seeded = false;
        $env->app->store->onSeed = function () use (&$seeded) {
            $seeded = true;
        };
        $err = T::err($env->call('GET', '/api/meta', null, 'mei'), 503, 'DATA_CORRUPT');
        T::eq('missing', $err['details']['reason']);
        T::eq(false, $seeded);
        T::eq(false, file_exists($env->dir . '/plan.json'));
        $env->cleanup();
    },
    'a missing secret.key is recreated and old tokens stop working' => function () use ($now) {
        $env = TestEnv::make($now);
        $tok = 'token:' . $env->token('mei');
        T::ok($env->call('GET', '/api/me', null, $tok));
        unlink($env->dir . '/secret.key');
        T::err($env->call('GET', '/api/me', null, $tok), 401, 'UNAUTHORIZED');
        T::true(is_file($env->dir . '/secret.key'), 'recreated');
        $login = T::ok($env->call('POST', '/api/login', ['username' => 'mei', 'password' => TestEnv::PASSWORD]));
        T::ok($env->call('GET', '/api/me', null, 'token:' . $login['token']));
        $env->cleanup();
    },
    'writes keep a .bak of the previous plan and leave no temp files' => function () use ($now) {
        $env = TestEnv::make($now);
        T::ok($env->call('PUT', '/api/trucks', ['trucks' => [['plate' => 'SBA1234X', 'active' => true]]], 'mei'));
        $bak = json_decode((string) file_get_contents($env->dir . '/plan.json.bak'), true);
        T::eq([], $bak['trucks'], '.bak holds the previous version');
        T::eq('SBA1234X', $env->doc('plan')['trucks'][0]['plate']);
        T::eq([], glob($env->dir . '/.*.tmp') ?: [], 'no temp files');
        $env->cleanup();
    },
    'unchanged documents are not rewritten' => function () use ($now) {
        $env = TestEnv::make($now);
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::eq(false, file_exists($env->dir . '/plan.json.bak'));
        T::eq(false, file_exists($env->dir . '/users.json.bak'));
        $env->cleanup();
    },
    'a transaction that throws writes nothing' => function () use ($now) {
        $env = TestEnv::make($now);
        $store = new FileStore($env->config);
        $before = file_get_contents($env->dir . '/plan.json');
        try {
            $store->transaction(function (Tx $tx) {
                $plan = $tx->get('plan');
                $plan['trucks'] = [['plate' => 'X1', 'active' => true]];
                $tx->put('plan', $plan);
                $tx->put('day:2026-11-11', FileStore::emptyDay('2026-11-11') + ['x' => 1]);
                throw new ApiError('VALIDATION');
            });
            T::fail('expected ApiError');
        } catch (ApiError $e) {
            T::eq('VALIDATION', $e->errorCode);
        }
        T::eq($before, file_get_contents($env->dir . '/plan.json'));
        T::eq(false, file_exists($env->dir . '/days/2026-11-11.json'));
        T::eq(false, $store->isLocked(), 'lock released in finally');
        // and the lock can be taken again
        T::eq(1, $store->transaction(fn (Tx $tx) => 1));
        $env->cleanup();
    },
    'a missing day reads as an empty day; documents are cached in the transaction' => function () use ($now) {
        $env = TestEnv::make($now);
        $store = new FileStore($env->config);
        $store->transaction(function (Tx $tx) {
            T::eq(['date' => '2026-11-11', 'plan' => null, 'runs' => [], 'dropped_runs' => [], 'submissions' => []], $tx->get('day:2026-11-11'));
            $p = $tx->get('plan');
            $p['x'] = 1;
            $tx->put('plan', $p);
            T::eq(1, $tx->get('plan')['x'], 'put is visible to later gets');
        });
        T::eq(1, $env->doc('plan')['x']);
        $env->cleanup();
    },
    'bad document names are refused' => function () use ($now) {
        $env = TestEnv::make($now);
        $store = new FileStore($env->config);
        try {
            $store->transaction(fn (Tx $tx) => $tx->get('day:../../etc/passwd'));
            T::fail('expected InvalidArgumentException');
        } catch (InvalidArgumentException) {
            T::true(true);
        }
        $env->cleanup();
    },
    'Blobs put is idempotent and paths are checked' => function () use ($now) {
        $env = TestEnv::make($now);
        $blobs = new Blobs($env->dir);
        $uuid = '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1';
        T::eq([$uuid, 'jpg'], Blobs::parseName("$uuid.jpg"));
        T::eq(null, Blobs::parseName('../x.jpg'));
        $path = $blobs->put($uuid, 'jpg', "\xFF\xD8\xFFabc");
        T::eq("files/0b/$uuid.jpg", $path);
        T::eq($path, $blobs->put($uuid, 'jpg', 'other bytes'));
        T::eq("\xFF\xD8\xFFabc", file_get_contents("$env->dir/$path"), 'not overwritten');
        T::true($blobs->exists($path));
        T::true(!$blobs->exists('files/../../plan.json'));
        $env->cleanup();
    },
    'concurrent processes are serialised by the lock (no lost update, valid JSON)' => function () use ($now) {
        $env = TestEnv::make($now);
        $script = $env->dir . '/inc.php';
        file_put_contents($script, '<?php $config = require ' . var_export(realpath(__DIR__ . '/../../bootstrap.php'), true) . ';'
            . '$store = new FileStore(array_replace($config, ["data_dir" => $argv[1]]));'
            . 'for ($i = 0; $i < 10; $i++) { $store->transaction(function (Tx $tx) { $p = $tx->get("plan");'
            . ' $p["seq"]["route"]++; usleep(500); $tx->put("plan", $p); }); }');
        $procs = [];
        for ($i = 0; $i < 6; $i++) {
            $procs[] = proc_open([PHP_BINARY, $script, $env->dir], [], $pipes);
        }
        foreach ($procs as $p) {
            T::eq(0, proc_close($p), 'worker exit code');
        }
        T::eq(60, $env->doc('plan')['seq']['route'], 'every increment kept');
        T::true(is_array(json_decode((string) file_get_contents($env->dir . '/plan.json.bak'), true)), '.bak decodes');
        T::eq([], glob($env->dir . '/.*.tmp') ?: [], 'no temp files');
        $env->cleanup();
    },
];
