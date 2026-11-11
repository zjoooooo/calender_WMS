<?php
// Extension points, so other parts plug in without editing the router or other people's handlers.
// Hook files live in src/hooks/*.php (loaded in name order by App::create). A hook file only calls
// Hooks::add()/beforeRequest()/onPlanWrite(); it must NOT declare classes or functions (it is
// re-required in tests).
//
// Events:
//   before_request  fn(Ctx $c): void
//       Runs at the start of every locked request, after the clock is read and $c->today is known,
//       before auth. Order: 10 = R13 day freeze + CLOCK_BEHIND_FREEZE (Schedule), 20 = R16 holiday
//       seed import (src/hooks/holiday_seed.php). Write documents with $c->tx->put().
//   plan_write      fn(Ctx $c, array $before, array &$after, array $opts): void
//       Runs inside Ctx::savePlan() before plan.json is put. $opts['release_run'] (bool) carries the
//       request's release_run. Use it for the R26 run invariant (throw ApiError RUN_EXISTS or move
//       runs to dropped_runs / append run.removed), R9 override cleanup/purge, etc.
//   user_deactivated fn(Ctx $c, array $user): void
//       Runs when an admin sets active=false on a user, or changes a driver's role to another role
//       (R24: release every job a driver holds).
//
// Adding a hook with an existing (event, name) replaces it.
final class Hooks
{
    public const BEFORE_REQUEST = 'before_request';
    public const PLAN_WRITE = 'plan_write';
    public const USER_DEACTIVATED = 'user_deactivated';

    /** @var array<string, array<string, array{0:int,1:callable}>> */
    private static array $hooks = [];

    public static function add(string $event, string $name, callable $fn, int $order = 50): void
    {
        self::$hooks[$event][$name] = [$order, $fn];
    }

    public static function beforeRequest(string $name, callable $fn, int $order = 50): void
    {
        self::add(self::BEFORE_REQUEST, $name, $fn, $order);
    }

    public static function onPlanWrite(string $name, callable $fn, int $order = 50): void
    {
        self::add(self::PLAN_WRITE, $name, $fn, $order);
    }

    public static function remove(string $event, string $name): void
    {
        unset(self::$hooks[$event][$name]);
    }

    public static function has(string $event, string $name): bool
    {
        return isset(self::$hooks[$event][$name]);
    }

    /** @return list<callable> sorted by order, then name */
    public static function listeners(string $event): array
    {
        $list = self::$hooks[$event] ?? [];
        uksort($list, static fn ($a, $b) => [$list[$a][0], $a] <=> [$list[$b][0], $b]);
        return array_map(static fn ($h) => $h[1], array_values($list));
    }

    public static function run(string $event, mixed ...$args): void
    {
        foreach (self::listeners($event) as $fn) {
            $fn(...$args);
        }
    }

    public static function reset(): void
    {
        self::$hooks = [];
    }

    public static function loadDir(string $dir): void
    {
        $files = glob(rtrim($dir, '/') . '/*.php') ?: [];
        sort($files);
        foreach ($files as $f) {
            require $f;
        }
    }
}
