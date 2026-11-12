<?php
// R35 files (§10.10): PUT /api/files/{uuid}.{jpg|png} (raw, idempotent, magic bytes, size limits) and
// GET /api/files/{name} (any signed-in user, streamed with immutable caching). Both run outside the lock.
require_once __DIR__ . '/../runs_lib.php';

return (static function (): array {
    $name = static fn (int $n, string $ext = 'jpg') => RunsFx::op($n) . '.' . $ext;
    $bytes = static function (Response $r): string {
        ob_start();
        ($r->stream)();
        return (string) ob_get_clean();
    };

    return [
        'upload: 201 then 200 (idempotent, the stored file never changes); stored under files/<2 chars>/' => function () use ($name) {
            $e = RunsFx::env();
            T::eq(['path' => 'files/00/' . $name(1)], T::ok(RunsFx::upload($e, $name(1), RunsFx::jpeg('first')), 201));
            T::eq(['path' => 'files/00/' . $name(1)], T::ok(RunsFx::upload($e, $name(1), RunsFx::jpeg('second')), 200));
            T::eq(RunsFx::jpeg('first'), $e->doc('file:files/00/' . $name(1))['content']);
            T::ok(RunsFx::upload($e, $name(2, 'png'), RunsFx::png(), 'mei'), 201);
            T::ok(RunsFx::upload($e, '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg', RunsFx::jpeg(), 'admin'), 201);
            T::true($e->doc('file:files/0b/0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg')['exists']);
            $lines = array_values(array_filter($e->doc('audit:2026-11'), static fn ($l) => $l['method'] === 'PUT'));
            T::eq(4, count($lines), 'every successful upload (201 or 200) is audited');
            T::eq(null, $lines[0]['body'], 'file bytes are never logged');
        },

        'upload refusals: FILE_INVALID (name, magic bytes, empty), FILE_TOO_LARGE (2 MB jpg, 300 KB png), 401' => function () use ($name) {
            $e = RunsFx::env();
            foreach (['photo.jpg', 'AB6E1C2A-7F3D-4C55-9A1E-2B9D6A0C31F1.jpg', '0b6e1c2a-7f3d-1c55-9a1e-2b9d6a0c31f1.jpg', RunsFx::op(3) . '.gif', RunsFx::op(3) . '.jpeg'] as $bad) {
                T::err(RunsFx::upload($e, $bad, RunsFx::jpeg()), 422, 'FILE_INVALID');
            }
            T::err(RunsFx::upload($e, $name(4), RunsFx::png()), 422, 'FILE_INVALID');
            T::err(RunsFx::upload($e, $name(4, 'png'), RunsFx::jpeg()), 422, 'FILE_INVALID');
            T::err(RunsFx::upload($e, $name(4), ''), 422, 'FILE_INVALID');
            T::subset(['details' => ['max_bytes' => 2000000]], T::err(RunsFx::upload($e, $name(5), RunsFx::jpeg(str_repeat('x', 2000000 - 3))), 413, 'FILE_TOO_LARGE'));
            T::ok(RunsFx::upload($e, $name(5), RunsFx::jpeg(str_repeat('x', 2000000 - 4))), 201); // exactly 2,000,000 bytes
            T::err(RunsFx::upload($e, $name(6, 'png'), RunsFx::png(str_repeat('x', 300000 - 7))), 413, 'FILE_TOO_LARGE');
            T::ok(RunsFx::upload($e, $name(6, 'png'), RunsFx::png(str_repeat('x', 300000 - 8))), 201);
            T::err($e->call('PUT', '/api/files/' . $name(7), null, null, ['raw' => RunsFx::jpeg()]), 401, 'UNAUTHORIZED');
        },

        'download: any signed-in user gets the bytes with immutable caching and nosniff; 404 for unknown files' => function () use ($name, $bytes) {
            $e = RunsFx::env();
            T::ok(RunsFx::upload($e, $name(1), RunsFx::jpeg('abc')), 201);
            T::ok(RunsFx::upload($e, $name(2, 'png'), RunsFx::png('sig')), 201);
            foreach (['ali', 'mei', 'admin'] as $u) {
                $r = $e->call('GET', '/api/files/' . $name(1), null, $u);
                T::eq(200, $r['status']);
                T::eq('image/jpeg', $r['headers']['Content-Type']);
                T::eq('private, max-age=31536000, immutable', $r['headers']['Cache-Control']);
                T::eq('nosniff', $r['headers']['X-Content-Type-Options']);
                T::eq((string) strlen(RunsFx::jpeg('abc')), $r['headers']['Content-Length']);
                T::eq(RunsFx::jpeg('abc'), $bytes($r['response']));
            }
            $r = $e->call('GET', '/api/files/' . $name(2, 'png'), null, 'ali');
            T::eq('image/png', $r['headers']['Content-Type']);
            T::eq(RunsFx::png('sig'), $bytes($r['response']));
            T::err($e->call('GET', '/api/files/' . $name(3), null, 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/files/..%2Fplan.json', null, 'ali'), 404, 'NOT_FOUND');
            T::err($e->call('GET', '/api/files/' . $name(1), null), 401, 'UNAUTHORIZED');
        },

        'both file routes are raw/unlocked: the handler runs after the lock is released' => function () use ($name) {
            $e = RunsFx::env();
            [$put] = $e->app->match('PUT', '/api/files/' . $name(1));
            [$get] = $e->app->match('GET', '/api/files/' . $name(1));
            T::subset(['raw' => true, 'unlocked' => true], $put['opts']);
            T::subset(['unlocked' => true], $get['opts']);
            T::eq(2000000, $e->app->maxBody('PUT', '/api/files/' . $name(1)), 'the body read before the lock is capped at the jpg limit (+1 byte)');
            $locked = null;
            $e->app->addRoute('PUT', '/api/t/probe/{name}', static function (Ctx $c) use ($e, &$locked) {
                $locked = $e->app->store->isLocked();
                return Files::put($c);
            }, 'any', ['raw' => true, 'unlocked' => true]);
            T::ok($e->call('PUT', '/api/t/probe/' . $name(9), null, 'ali', ['raw' => RunsFx::jpeg()]), 201);
            T::eq(false, $locked);
        },
    ];
})();
