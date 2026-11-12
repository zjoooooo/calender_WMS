<?php
// Router and extension points (App, Hooks): modular routes, matching order, options, hooks.
$now = '2026-11-11T10:00:00+08:00';

return [
    'routes match static paths first, then patterns; custom regex params' => function () use ($now) {
        $env = TestEnv::make($now);
        $env->app->addRoute('GET', '/api/things/{id:\d+}', fn (Ctx $c) => ['id' => $c->intParam('id')], 'any');
        $env->app->addRoute('GET', '/api/things/{name}', fn (Ctx $c) => ['name' => $c->param('name')], 'any');
        $env->app->addRoute('GET', '/api/things/special', fn (Ctx $c) => ['static' => true], 'any');
        T::eq(['id' => 42], T::ok($env->call('GET', '/api/things/42', null, 'mei')));
        T::eq(['name' => 'abc'], T::ok($env->call('GET', '/api/things/abc', null, 'mei')));
        T::eq(['static' => true], T::ok($env->call('GET', '/api/things/special', null, 'mei')));
        T::err($env->call('GET', '/api/things/1/2', null, 'mei'), 404, 'NOT_FOUND');
        $env->cleanup();
    },
    'a duplicate route is refused at load time' => function () use ($now) {
        $env = TestEnv::make($now);
        try {
            $env->app->addRoute('GET', '/api/meta', fn () => 1, 'any');
            T::fail('expected LogicException');
        } catch (LogicException $e) {
            T::true(str_contains($e->getMessage(), 'Duplicate route'));
        }
        $env->cleanup();
    },
    'handlers: created, noContent, warnings, query helpers, Response passthrough' => function () use ($now) {
        $env = TestEnv::make($now);
        $env->app->addRoute('POST', '/api/t/created', function (Ctx $c) {
            $c->warn('EMPTY_ROUTE', 'Route has no stops');
            return $c->created(['q' => $c->query('a'), 'flag' => $c->queryBool('f'), 'body' => $c->body]);
        }, ['admin', 'office']);
        $env->app->addRoute('DELETE', '/api/t/gone', fn (Ctx $c) => $c->noContent(), 'any');
        $env->app->addRoute('GET', '/api/t/raw', fn (Ctx $c) => new Response(200, ['Content-Type' => 'text/plain'], 'hello'), 'any');
        $r = $env->call('POST', '/api/t/created?a=x&f=1', ['k' => 'v'], 'mei');
        T::eq(['q' => 'x', 'flag' => true, 'body' => ['k' => 'v']], T::ok($r, 201));
        T::eq([['code' => 'EMPTY_ROUTE', 'message' => 'Route has no stops']], $r['json']['warnings']);
        T::eq(204, $env->call('DELETE', '/api/t/gone', null, 'mei')['status']);
        $raw = $env->call('GET', '/api/t/raw', null, 'mei');
        T::eq('hello', $raw['response']->body);
        T::eq('nosniff', $raw['headers']['X-Content-Type-Options']);
        $env->cleanup();
    },
    'an unexpected exception becomes 500 INTERNAL and writes nothing' => function () use ($now) {
        $env = TestEnv::make($now);
        $env->app->addRoute('POST', '/api/t/boom', function (Ctx $c) {
            $plan = $c->plan();
            $plan['trucks'] = [['plate' => 'X', 'active' => true]];
            $c->savePlan($plan);
            throw new RuntimeException('boom');
        }, 'any');
        $old = ini_set('error_log', '/dev/null');
        T::err($env->call('POST', '/api/t/boom', [], 'mei'), 500, 'INTERNAL');
        ini_set('error_log', (string) $old);
        T::eq([], $env->doc('plan')['trucks']);
        T::eq([], $env->doc('audit:2026-11'));
        $env->cleanup();
    },
    'unlocked routes: auth and hooks under the lock, handler outside it' => function () use ($now) {
        $env = TestEnv::make($now);
        $seen = [];
        $env->app->addRoute('PUT', '/api/t/blob', function (Ctx $c) use ($env, &$seen) {
            $seen = ['locked' => $env->app->store->isLocked(), 'tx' => $c->tx, 'user' => $c->user['username'],
                'today' => $c->today, 'body' => $c->req->body];
            return $c->created(['ok' => 1]);
        }, ['driver', 'office', 'admin'], ['unlocked' => true, 'raw' => true, 'max_body' => 10]);
        T::ok($env->call('PUT', '/api/t/blob', null, 'ali', ['raw' => "\xFF\xD8\xFFbytes"]), 201);
        T::eq(['locked' => false, 'tx' => null, 'user' => 'ali', 'today' => '2026-11-11', 'body' => "\xFF\xD8\xFFbytes"], $seen);
        T::eq(10, $env->app->maxBody('PUT', '/api/t/blob'));
        T::eq(1048576, $env->app->maxBody('GET', '/api/meta'));
        $lines = $env->doc('audit:2026-11');
        T::eq(null, $lines[0]['body'], 'raw bodies are never logged');
        T::err($env->call('PUT', '/api/t/blob', null, null, ['raw' => 'x']), 401, 'UNAUTHORIZED');
        $env->cleanup();
    },
    'before_request hooks run in order with today set, under the lock, before auth' => function () use ($now) {
        $env = TestEnv::make('2026-11-12T03:30:00+08:00');
        $log = [];
        Hooks::beforeRequest('second', function (Ctx $c) use (&$log) {
            $log[] = "second:$c->today:" . ($c->user === null ? 'anon' : 'user');
        }, 30);
        Hooks::beforeRequest('first', function (Ctx $c) use (&$log, $env) {
            $log[] = 'first:' . ($env->app->store->isLocked() ? 'locked' : 'unlocked');
        }, 10);
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::eq(['first:locked', 'second:2026-11-11:anon'], $log);
        // a hook can stop every request (e.g. CLOCK_BEHIND_FREEZE) and nothing is written
        Hooks::beforeRequest('first', function (Ctx $c) {
            $p = $c->plan();
            $p['trucks'] = [['plate' => 'X', 'active' => true]];
            $c->tx->put('plan', $p);
            throw new ApiError('CLOCK_BEHIND_FREEZE', 503, null, ['frozen_through' => '2026-11-11', 'today' => $c->today]);
        }, 10);
        T::err($env->call('POST', '/api/login', ['username' => 'ali', 'password' => TestEnv::PASSWORD]), 503, 'CLOCK_BEHIND_FREEZE');
        T::eq([], $env->doc('plan')['trucks']);
        $env->cleanup();
    },
    'plan_write hooks see before/after, may change the plan or refuse the write' => function () use ($now) {
        $env = TestEnv::make($now, ['fixture' => 'basic']);
        $calls = [];
        Hooks::onPlanWrite('r26', function (Ctx $c, array $before, array &$after, array $opts) use (&$calls) {
            $calls[] = ['release_run' => $opts['release_run'] ?? false, 'before' => count($before['holidays']), 'after' => count($after['holidays'])];
            if (($opts['release_run'] ?? false) === false && count($after['holidays']) > count($before['holidays'])) {
                throw new ApiError('RUN_EXISTS', 409, null, ['runs' => []]);
            }
            $after['touched_by_hook'] = true;
        });
        T::err($env->call('PUT', '/api/holidays/2026-11-20', ['name' => 'X'], 'mei'), 409, 'RUN_EXISTS');
        T::true(!in_array('2026-11-20', array_column($env->doc('plan')['holidays'], 'date'), true), 'not saved');
        T::ok($env->call('PUT', '/api/holidays/2026-11-20', ['name' => 'X', 'release_run' => true], 'mei'), 201);
        T::eq(true, $env->doc('plan')['touched_by_hook']);
        T::eq(204, $env->call('DELETE', '/api/holidays/2026-11-20?release_run=1', null, 'mei')['status']);
        T::eq([
            ['release_run' => false, 'before' => 6, 'after' => 7],
            ['release_run' => true, 'before' => 6, 'after' => 7],
            ['release_run' => true, 'before' => 7, 'after' => 6],
        ], $calls);
        $env->cleanup();
    },
    'hooks: same name replaces, listeners sorted by order' => function () {
        Hooks::reset();
        Hooks::add('x', 'b', fn () => 'b', 20);
        Hooks::add('x', 'a', fn () => 'a1', 20);
        Hooks::add('x', 'a', fn () => 'a2', 20);
        Hooks::add('x', 'z', fn () => 'z', 5);
        T::eq(['z', 'a2', 'b'], array_map(fn ($f) => $f(), Hooks::listeners('x')));
        T::true(Hooks::has('x', 'a'));
        Hooks::remove('x', 'a');
        T::eq(false, Hooks::has('x', 'a'));
        Hooks::reset();
    },
    'every route file entry is valid and every handler is callable' => function () use ($now) {
        $env = TestEnv::make($now); // App::create throws on a bad entry
        foreach ([['GET', '/api/customers/12'], ['PATCH', '/api/waste-types/REL'], ['PUT', '/api/waste-types/order'], ['PUT', '/api/holidays/2026-12-31']] as [$m, $p]) {
            [$route] = $env->app->match($m, $p);
            T::true($route !== null, "$m $p matches");
        }
        [$route] = $env->app->match('PUT', '/api/waste-types/order');
        T::eq('/api/waste-types/order', $route['pattern']);
        $env->cleanup();
    },
];
