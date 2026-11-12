<?php
// Users page (admin) and the drivers list (office) (R33, R24, R25, §10.7).
final class Users
{
    public static function out(array $u, DateTimeImmutable $now): array
    {
        return [
            'id' => $u['id'], 'username' => $u['username'], 'name' => $u['name'], 'role' => $u['role'],
            'lang' => $u['lang'], 'active' => (bool) $u['active'],
            'must_change_password' => (bool) ($u['must_change_password'] ?? false),
            'locked_until' => Auth::lockedUntil($u, $now),
        ];
    }

    /** GET /api/users (admin) */
    public static function list(Ctx $c): array
    {
        return array_map(static fn ($u) => self::out($u, $c->now), $c->users()['users'] ?? []);
    }

    /** POST /api/users {username, name, role, lang, password} (admin) -> 201 | USERNAME_TAKEN | PASSWORD_TOO_SHORT */
    public static function create(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['username', 'name', 'role', 'lang', 'password']);
        $username = strtolower(trim(is_string($b['username'] ?? null) ? $b['username'] : ''));
        if (!preg_match(Auth::USERNAME_RE, $username)) {
            V::fail('username', 'The username must be 3-30 of a-z, 0-9, ".", "_" or "-"');
        }
        $users = $c->users();
        if (Auth::indexByUsername($users, $username) !== null) {
            throw new ApiError('USERNAME_TAKEN', 422, 'username');
        }
        $id = (int) ($users['seq'] ?? 0) + 1;
        $u = [
            'id' => $id,
            'username' => $username,
            'name' => V::str($b['name'] ?? null, 'name', 1, 60),
            'role' => V::enum($b['role'] ?? null, 'role', Auth::ROLES),
            'lang' => V::enum($b['lang'] ?? 'zh', 'lang', Auth::LANGS),
            'password_hash' => Auth::hash(Auth::checkNewPassword($b['password'] ?? null, 'password')),
            // The admin knows this password, as after a reset: the user sets their own at first login.
            'must_change_password' => true,
            'active' => true,
            'token_version' => 1,
            'failed_logins' => [],
        ];
        $users['seq'] = $id;
        $users['users'][] = $u;
        $c->saveUsers($users);
        return $c->created(self::out($u, $c->now));
    }

    /**
     * PATCH /api/users/{id} {name?, role?, lang?, active?, password?} (admin).
     * password = reset: must_change_password, login locks cleared, token_version bumped.
     * active=false: token_version bumped and the user_deactivated hook releases held jobs (R24).
     * A role change away from driver releases the jobs the user holds in the same way: a non-driver
     * can no longer enter results, so the job must not stay "active" under them.
     */
    public static function patch(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['name', 'role', 'lang', 'active', 'password']);
        $users = $c->users();
        $i = Auth::indexById($users, $c->intParam('id'));
        if ($i === null) {
            throw new ApiError('NOT_FOUND', 404, 'id', null, 'User not found');
        }
        $u = $users['users'][$i];
        $wasActive = !empty($u['active']);
        if (array_key_exists('name', $b)) {
            $u['name'] = V::str($b['name'], 'name', 1, 60);
        }
        if (array_key_exists('role', $b)) {
            $u['role'] = V::enum($b['role'], 'role', Auth::ROLES);
        }
        if (array_key_exists('lang', $b)) {
            $u['lang'] = V::enum($b['lang'], 'lang', Auth::LANGS);
        }
        if (array_key_exists('active', $b)) {
            $u['active'] = V::bool($b['active'], 'active');
        }
        if (array_key_exists('password', $b)) {
            $u['password_hash'] = Auth::hash(Auth::checkNewPassword($b['password'], 'password'));
            $u['must_change_password'] = true;
            $u['failed_logins'] = [];
            $u['token_version'] = (int) ($u['token_version'] ?? 0) + 1;
        }
        // R33: the last active admin cannot be deactivated or demoted.
        $wasAdmin = $users['users'][$i]['role'] === 'admin' && $wasActive;
        $isAdmin = $u['role'] === 'admin' && !empty($u['active']);
        if ($wasAdmin && !$isAdmin) {
            $others = 0;
            foreach ($users['users'] as $k => $o) {
                if ($k !== $i && $o['role'] === 'admin' && !empty($o['active'])) {
                    $others++;
                }
            }
            if ($others === 0) {
                throw new ApiError('LAST_ADMIN', 422, array_key_exists('role', $b) ? 'role' : 'active');
            }
        }
        $deactivated = $wasActive && empty($u['active']);
        if ($deactivated) {
            $u['token_version'] = (int) ($u['token_version'] ?? 0) + 1;
        }
        $noLongerDriver = $users['users'][$i]['role'] === 'driver' && $u['role'] !== 'driver';
        $users['users'][$i] = $u;
        $c->saveUsers($users);
        if ($deactivated || $noLongerDriver) {
            Hooks::run(Hooks::USER_DEACTIVATED, $c, $u);
        }
        return self::out($u, $c->now);
    }

    /**
     * GET /api/drivers (office) -> [{id, name, active, route_job, task_jobs}]
     * route_job/task_jobs follow R25: jobs held today only (driver_id = X, date = today, pending > 0).
     */
    public static function drivers(Ctx $c): array
    {
        $plan = $c->plan();
        $day = $c->tx->get('day:' . $c->today);
        $names = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $names[$cu['id']] = $cu['name'];
        }
        $out = [];
        foreach ($c->users()['users'] ?? [] as $u) {
            if ($u['role'] !== 'driver') {
                continue;
            }
            $held = self::heldJobs($plan, $day, $u['id']);
            $route = null;
            $tasks = [];
            foreach ($held as $h) {
                if ($h['kind'] === 'route') {
                    $route ??= ['date' => $day['date'], 'job' => $h['job'], 'code' => $h['code'], 'pending' => $h['pending']];
                } else {
                    $tasks[] = ['job' => $h['job'], 'customer' => $names[$h['customer_id']] ?? ''];
                }
            }
            $out[] = ['id' => $u['id'], 'name' => $u['name'], 'active' => (bool) $u['active'], 'route_job' => $route, 'task_jobs' => $tasks];
        }
        return $out;
    }

    /**
     * Jobs a driver holds in a day file (R25: run.driver_id = X and pending > 0).
     * @return list<array{job:string,kind:string,code:?string,customer_id:?int,pending:int}>
     */
    public static function heldJobs(array $plan, array $day, int $driverId): array
    {
        $codes = [];
        foreach ($plan['routes'] ?? [] as $r) {
            $codes[$r['id']] = $r['code'];
        }
        $taskCustomer = [];
        foreach ($plan['tasks'] ?? [] as $t) {
            $taskCustomer[$t['id']] = (int) $t['customer_id'];
        }
        $out = [];
        foreach ($day['runs'] ?? [] as $job => $run) {
            $job = (string) $job;
            if (($run['driver_id'] ?? null) !== $driverId) {
                continue;
            }
            $pending = Usage::pendingCount($plan, (string) $day['date'], $job, $run);
            if ($pending <= 0) {
                continue;
            }
            $id = (int) substr($job, 1);
            $isRoute = str_starts_with($job, 'r');
            $out[] = ['job' => $job, 'kind' => $isRoute ? 'route' : 'task', 'code' => $isRoute ? ($codes[$id] ?? null) : null,
                'customer_id' => $isRoute ? null : ($taskCustomer[$id] ?? null), 'pending' => $pending];
        }
        return $out;
    }
}
