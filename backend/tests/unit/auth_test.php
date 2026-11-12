<?php
// R33/R34: login, tokens, lockout per username + IP, forced password change, roles, audit redaction.
$now = '2026-11-11T07:40:00+08:00';
$login = static fn (TestEnv $env, string $u, string $p, string $ip = '10.0.0.1') =>
    $env->call('POST', '/api/login', ['username' => $u, 'password' => $p], null, ['ip' => $ip]);

return [
    'login returns a token and the user' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        $d = T::ok($login($env, 'ali', TestEnv::PASSWORD));
        T::subset(['user' => ['id' => 3, 'username' => 'ali', 'name' => 'Ali', 'role' => 'driver', 'lang' => 'en', 'must_change_password' => false]], $d);
        T::eq(false, isset($d['user']['password_hash']));
        $me = T::ok($env->call('GET', '/api/me', null, 'token:' . $d['token']));
        T::eq('ali', $me['username']);
        T::ok($login($env, 'ALI', TestEnv::PASSWORD)); // case-insensitive username
        $env->cleanup();
    },
    'wrong password and unknown username both give BAD_CREDENTIALS' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        T::err($login($env, 'ali', 'wrong-password'), 401, 'BAD_CREDENTIALS');
        T::err($login($env, 'nobody', 'wrong-password'), 401, 'BAD_CREDENTIALS');
        T::err($env->call('POST', '/api/login', ['username' => 'ali']), 401, 'BAD_CREDENTIALS');
        T::err($env->call('POST', '/api/login', ['username' => 'ali', 'password' => 'x', 'extra' => 1]), 422, 'VALIDATION');
        T::eq(2, $env->doc('users')['users'][2]['failed_logins']['10.0.0.1']['n'], 'both counted for the known user');
        $env->cleanup();
    },
    'token checks: signature, expiry, token_version, active' => function () use ($now) {
        $env = TestEnv::make($now);
        $tok = $env->token('ali');
        T::ok($env->call('GET', '/api/me', null, "token:$tok"));
        [$payload, $sig] = explode('.', $tok);
        $forged = Auth::b64u(json_encode(['uid' => 1, 'tv' => 1, 'exp' => 4102444800])) . '.' . $sig;
        T::err($env->call('GET', '/api/me', null, "token:$forged"), 401, 'UNAUTHORIZED');
        T::err($env->call('GET', '/api/me', null, 'token:garbage'), 401, 'UNAUTHORIZED');
        T::err($env->call('GET', '/api/me'), 401, 'UNAUTHORIZED');
        // expiry: 30 days
        $env->setNow('2026-12-11T07:39:00+08:00');
        T::ok($env->call('GET', '/api/me', null, "token:$tok"));
        $env->setNow('2026-12-11T07:41:00+08:00');
        T::err($env->call('GET', '/api/me', null, "token:$tok"), 401, 'UNAUTHORIZED');
        $env->cleanup();
    },
    'lockout after 5 wrong passwords, per username and IP, for 10 minutes' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        for ($i = 1; $i <= 4; $i++) {
            T::err($login($env, 'ali', "wrong-$i"), 401, 'BAD_CREDENTIALS');
        }
        $e = T::err($login($env, 'ali', 'wrong-5'), 423, 'ACCOUNT_LOCKED');
        T::eq('2026-11-11T07:50:00+08:00', $e['details']['until']);
        // even the right password is refused from that IP
        T::err($login($env, 'ali', TestEnv::PASSWORD), 423, 'ACCOUNT_LOCKED');
        // another IP is not locked, another user from the same IP is not locked
        T::ok($login($env, 'ali', TestEnv::PASSWORD, '10.0.0.2'));
        T::ok($login($env, 'bala', TestEnv::PASSWORD));
        // the Users page shows the lock
        $users = T::ok($env->call('GET', '/api/users', null, 'admin'));
        T::eq('2026-11-11T07:50:00+08:00', $users[2]['locked_until']);
        // after 10 minutes the lock is over and the counter restarts
        $env->setNow('2026-11-11T07:49:59+08:00');
        T::err($login($env, 'ali', TestEnv::PASSWORD), 423, 'ACCOUNT_LOCKED');
        $env->setNow('2026-11-11T07:50:00+08:00');
        T::ok($login($env, 'ali', TestEnv::PASSWORD));
        T::eq([], $env->doc('users')['users'][2]['failed_logins']);
        $env->cleanup();
    },
    'admin password reset clears the locks and forces a change' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        for ($i = 1; $i <= 5; $i++) {
            $login($env, 'ali', "wrong-$i");
        }
        $old = $env->token('ali');
        $u = T::ok($env->call('PATCH', '/api/users/3', ['password' => 'reset-pass-1'], 'admin'));
        T::eq(true, $u['must_change_password']);
        T::eq(null, $u['locked_until']);
        T::err($env->call('GET', '/api/me', null, "token:$old"), 401, 'UNAUTHORIZED');
        $d = T::ok($login($env, 'ali', 'reset-pass-1'));
        $tok = 'token:' . $d['token'];
        T::err($env->call('GET', '/api/meta', null, $tok), 403, 'PASSWORD_CHANGE_REQUIRED');
        T::err($env->call('PATCH', '/api/me', ['lang' => 'zh'], $tok), 403, 'PASSWORD_CHANGE_REQUIRED');
        T::ok($env->call('GET', '/api/me', null, $tok));
        T::err($env->call('POST', '/api/me/password', ['old' => 'wrong', 'new' => 'driver-pass-9'], $tok), 422, 'BAD_CREDENTIALS');
        T::err($env->call('POST', '/api/me/password', ['old' => 'reset-pass-1', 'new' => 'short'], $tok), 422, 'PASSWORD_TOO_SHORT');
        $n = T::ok($env->call('POST', '/api/me/password', ['old' => 'reset-pass-1', 'new' => 'driver-pass-9'], $tok));
        T::err($env->call('GET', '/api/me', null, $tok), 401, 'UNAUTHORIZED'); // token_version bumped
        T::ok($env->call('GET', '/api/meta', null, 'token:' . $n['token']));
        $env->cleanup();
    },
    'logout-all bumps token_version' => function () use ($now) {
        $env = TestEnv::make($now);
        $tok = 'token:' . $env->token('mei');
        $r = $env->call('POST', '/api/me/logout-all', null, $tok);
        T::eq(204, $r['status']);
        T::eq('', $r['response']->body);
        T::err($env->call('GET', '/api/me', null, $tok), 401, 'UNAUTHORIZED');
        $env->cleanup();
    },
    'PATCH /api/me switches the language' => function () use ($now) {
        $env = TestEnv::make($now);
        T::eq('zh', T::ok($env->call('PATCH', '/api/me', ['lang' => 'zh'], 'ali'))['lang']);
        T::eq('zh', $env->doc('users')['users'][2]['lang']);
        T::err($env->call('PATCH', '/api/me', ['lang' => 'ms'], 'ali'), 422, 'VALIDATION');
        T::err($env->call('PATCH', '/api/me', ['role' => 'admin'], 'ali'), 422, 'VALIDATION');
        $env->cleanup();
    },
    'role matrix' => function () use ($now) {
        $env = TestEnv::make($now);
        $cases = [
            // [method, path, body, user, expected status]
            ['GET', '/api/meta', null, 'ali', 200],
            ['GET', '/api/me', null, 'ali', 200],
            ['GET', '/api/customers', null, 'ali', 403],
            ['GET', '/api/holidays', null, 'ali', 403],
            ['GET', '/api/drivers', null, 'ali', 403],
            ['GET', '/api/customers', null, 'mei', 200],
            ['GET', '/api/settings', null, 'mei', 200],
            ['PATCH', '/api/settings', ['rollover_hour' => 4], 'mei', 403],
            ['GET', '/api/users', null, 'mei', 403],
            ['POST', '/api/users', ['username' => 'x1x', 'name' => 'X', 'role' => 'driver', 'password' => 'password1'], 'mei', 403],
            ['POST', '/api/waste-types', ['code' => 'GLS', 'name' => 'Glass'], 'mei', 403],
            ['PUT', '/api/trucks', ['trucks' => []], 'mei', 200],
            ['GET', '/api/drivers', null, 'mei', 200],
            ['GET', '/api/users', null, 'admin', 200],
            ['PATCH', '/api/settings', ['rollover_hour' => 4], 'admin', 200],
        ];
        foreach ($cases as [$m, $p, $b, $u, $status]) {
            $r = $env->call($m, $p, $b, $u);
            T::eq($status, $r['status'], "$u $m $p " . T::show($r['json']));
            if ($status === 403) {
                T::eq('FORBIDDEN', $r['json']['error']['code']);
            }
        }
        $env->cleanup();
    },
    'LAST_ADMIN: the last active admin cannot be deactivated or demoted' => function () use ($now) {
        $env = TestEnv::make($now);
        T::err($env->call('PATCH', '/api/users/1', ['active' => false], 'admin'), 422, 'LAST_ADMIN');
        T::err($env->call('PATCH', '/api/users/1', ['role' => 'office'], 'admin'), 422, 'LAST_ADMIN');
        T::ok($env->call('PATCH', '/api/users/2', ['role' => 'admin'], 'admin'));
        T::eq('office', T::ok($env->call('PATCH', '/api/users/1', ['role' => 'office'], 'mei'))['role']);
        T::err($env->call('PATCH', '/api/users/2', ['active' => false], 'mei'), 422, 'LAST_ADMIN');
        $env->cleanup();
    },
    'a deactivated user cannot sign in and loses their tokens' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        $tok = 'token:' . $env->token('bala');
        T::ok($env->call('PATCH', '/api/users/4', ['active' => false], 'admin'));
        T::err($env->call('GET', '/api/me', null, $tok), 401, 'UNAUTHORIZED');
        T::err($login($env, 'bala', TestEnv::PASSWORD), 401, 'BAD_CREDENTIALS');
        T::ok($env->call('PATCH', '/api/users/4', ['active' => true], 'admin'));
        T::ok($login($env, 'bala', TestEnv::PASSWORD));
        $env->cleanup();
    },
    'audit log: one line per successful write, secrets removed' => function () use ($now, $login) {
        $env = TestEnv::make($now);
        T::ok($login($env, 'mei', TestEnv::PASSWORD));
        T::err($login($env, 'mei', 'wrong-password'), 401, 'BAD_CREDENTIALS');
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::ok($env->call('POST', '/api/me/password', ['old' => TestEnv::PASSWORD, 'new' => 'another-pass'], 'mei'));
        T::ok($env->call('POST', '/api/users', ['username' => 'chong', 'name' => 'Chong', 'role' => 'driver', 'password' => 'chong-pass-1'], 'admin'), 201);
        T::ok($env->call('PUT', '/api/holidays/2026-12-31', ['name' => 'Test'], 'mei'), 201);
        $lines = $env->doc('audit:2026-11');
        T::eq(4, count($lines), 'login, password, user, holiday');
        T::subset(['at' => '2026-11-11T07:40:00+08:00', 'user_id' => 2, 'username' => 'mei', 'method' => 'POST', 'path' => '/api/login',
            'status' => 200, 'body' => ['username' => 'mei', 'password' => ['$absent' => true]]], $lines[0]);
        T::eq([], $lines[1]['body'], 'old/new removed');
        T::subset(['path' => '/api/users', 'status' => 201, 'body' => ['username' => 'chong', 'password' => ['$absent' => true]]], $lines[2]);
        T::subset(['method' => 'PUT', 'path' => '/api/holidays/2026-12-31', 'body' => ['name' => 'Test']], $lines[3]);
        $raw = (string) file_get_contents($env->dir . '/audit/2026-11.jsonl');
        T::true(!str_contains($raw, 'another-pass') && !str_contains($raw, 'chong-pass-1') && !str_contains($raw, TestEnv::PASSWORD), 'no passwords');
        $env->cleanup();
    },
    'Http::redact removes password/old/new at any depth' => function () {
        T::eq(['a' => ['b' => [['c' => 1]]], 'x' => 2], Http::redact(['a' => ['b' => [['c' => 1, 'new' => 'n']], 'password' => 'p'], 'old' => 'o', 'x' => 2]));
    },
    'JSON body rules and unknown endpoints' => function () use ($now) {
        $env = TestEnv::make($now);
        T::err($env->call('POST', '/api/login', null, null, ['raw' => '{bad json']), 400, 'VALIDATION');
        T::err($env->call('POST', '/api/login', null, null, ['raw' => '[1,2]']), 400, 'VALIDATION');
        T::err($env->call('POST', '/api/login', null, null, ['raw' => str_repeat(' ', 1048577)]), 413, 'VALIDATION');
        T::err($env->call('GET', '/api/nothing-here', null, 'mei'), 404, 'NOT_FOUND');
        T::err($env->call('DELETE', '/api/meta', null, 'mei'), 404, 'NOT_FOUND');
        $r = $env->call('GET', '/api/health');
        T::eq(['ok' => true], T::ok($r));
        T::eq('no-store', $r['headers']['Cache-Control']);
        T::eq('nosniff', $r['headers']['X-Content-Type-Options']);
        T::eq('DENY', $r['headers']['X-Frame-Options']);
        $env->cleanup();
    },
];
