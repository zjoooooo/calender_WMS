<?php
// Accounts and sessions (R33, R34): password_hash, HMAC tokens, per-username+IP lockout,
// forced password change, and the /api/login and /api/me* handlers.
final class Auth
{
    /** password_verify() runs against this for unknown usernames, so timing does not reveal them (R34). */
    public const DUMMY_HASH = '$2y$10$i8AfTgddKrgnJ7hG.ae32OLx5zLG/X9uyu3qX/y.Q2PqZyA9LzFi6';
    public const MAX_FAILS = 5;
    public const LOCK_MINUTES = 10;
    public const USERNAME_RE = '/^[a-z0-9._-]{3,30}$/';
    public const ROLES = ['admin', 'office', 'driver'];
    public const LANGS = ['zh', 'en'];

    // ---- tokens -------------------------------------------------------------------------

    public static function b64u(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64uDecode(string $s): ?string
    {
        if (!preg_match('/^[A-Za-z0-9_-]*$/', $s)) {
            return null;
        }
        $d = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        return $d === false ? null : $d;
    }

    /** base64url(json{uid,tv,exp}) . "." . base64url(HMAC-SHA256(secret, payload)) (R34). */
    public static function issueToken(array $user, string $secret, int $nowTs, int $days): string
    {
        $payload = self::b64u(json_encode(['uid' => $user['id'], 'tv' => $user['token_version'], 'exp' => $nowTs + $days * 86400]));
        return $payload . '.' . self::b64u(hash_hmac('sha256', $payload, $secret, true));
    }

    /** The user record when the token is valid (signature, exp > now, active, tv = token_version), else null. */
    public static function verifyToken(string $token, array $usersDoc, string $secret, int $nowTs): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 2) {
            return null;
        }
        [$payload, $sig] = $parts;
        if (!hash_equals(self::b64u(hash_hmac('sha256', $payload, $secret, true)), $sig)) {
            return null;
        }
        $json = self::b64uDecode($payload);
        $data = $json === null ? null : json_decode($json, true);
        if (!is_array($data) || !is_int($data['uid'] ?? null) || !is_int($data['tv'] ?? null) || !is_int($data['exp'] ?? null)) {
            return null;
        }
        if ($data['exp'] <= $nowTs) {
            return null;
        }
        $i = self::indexById($usersDoc, $data['uid']);
        if ($i === null) {
            return null;
        }
        $u = $usersDoc['users'][$i];
        if (empty($u['active']) || ($u['token_version'] ?? 0) !== $data['tv']) {
            return null;
        }
        return $u;
    }

    public static function userFromToken(Ctx $c, string $token): ?array
    {
        return self::verifyToken($token, $c->users(), $c->store()->secretKey(), $c->now->getTimestamp());
    }

    public static function tokenFor(Ctx $c, array $user): string
    {
        return self::issueToken($user, $c->store()->secretKey(), $c->now->getTimestamp(), (int) $c->config('token_days'));
    }

    // ---- users helpers ------------------------------------------------------------------

    public static function indexById(array $usersDoc, int $id): ?int
    {
        foreach ($usersDoc['users'] ?? [] as $i => $u) {
            if (($u['id'] ?? null) === $id) {
                return $i;
            }
        }
        return null;
    }

    /** Case-insensitive username lookup. */
    public static function indexByUsername(array $usersDoc, string $username): ?int
    {
        $username = strtolower($username);
        foreach ($usersDoc['users'] ?? [] as $i => $u) {
            if (strtolower((string) ($u['username'] ?? '')) === $username) {
                return $i;
            }
        }
        return null;
    }

    /** The user as the API shows it (never the hash or the login counters). */
    public static function publicUser(array $u): array
    {
        return [
            'id' => $u['id'],
            'username' => $u['username'],
            'name' => $u['name'],
            'role' => $u['role'],
            'lang' => $u['lang'],
            'must_change_password' => (bool) ($u['must_change_password'] ?? false),
        ];
    }

    /** Validates a new password: at least 8 characters (PASSWORD_TOO_SHORT); bcrypt uses at most 72 bytes. */
    public static function checkNewPassword(mixed $p, string $field): string
    {
        if (!is_string($p)) {
            V::fail($field, "'$field' must be text");
        }
        if (!preg_match('/^.{8,}$/us', $p)) {
            throw new ApiError('PASSWORD_TOO_SHORT', 422, $field);
        }
        if (strlen($p) > 72) {
            V::fail($field, 'The password is longer than 72 bytes');
        }
        return $p;
    }

    public static function hash(string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    /** Drops expired locks and stale counters. */
    public static function pruneFails(array $fails, DateTimeImmutable $now): array
    {
        $out = [];
        foreach ($fails as $ip => $f) {
            if (!is_array($f)) {
                continue;
            }
            $until = Clock::parse($f['until'] ?? null);
            $last = Clock::parse($f['last'] ?? null);
            if ($until !== null && $until <= $now) {
                continue; // lock over: counter restarts
            }
            if ($until === null && ($last === null || $last < $now->modify('-1 day'))) {
                continue;
            }
            $out[(string) $ip] = $f;
        }
        return $out;
    }

    /** The latest per-IP lock still in force, or null (Users page, R34). */
    public static function lockedUntil(array $user, DateTimeImmutable $now): ?string
    {
        $best = null;
        foreach ($user['failed_logins'] ?? [] as $f) {
            $until = Clock::parse($f['until'] ?? null);
            if ($until !== null && $until > $now && ($best === null || $until > $best)) {
                $best = $until;
            }
        }
        return $best === null ? null : Clock::iso($best);
    }

    // ---- handlers -----------------------------------------------------------------------

    /** POST /api/login {username, password} -> {token, user} | 401 BAD_CREDENTIALS | 423 ACCOUNT_LOCKED {until} */
    public static function login(Ctx $c): array
    {
        V::only($c->body, ['username', 'password']);
        $username = is_string($c->body['username'] ?? null) ? strtolower(trim($c->body['username'])) : '';
        $password = is_string($c->body['password'] ?? null) ? $c->body['password'] : '';
        $users = $c->users();
        $i = $username === '' ? null : self::indexByUsername($users, $username);
        if ($i === null) {
            password_verify($password, self::DUMMY_HASH);
            throw new ApiError('BAD_CREDENTIALS', 401);
        }
        $u = $users['users'][$i];
        $ip = $c->req->ip !== '' ? $c->req->ip : 'unknown';
        $fails = self::pruneFails((array) ($u['failed_logins'] ?? []), $c->now);
        $entry = $fails[$ip] ?? null;
        if ($entry !== null && Clock::parse($entry['until'] ?? null) !== null) {
            // Still locked for this IP: the password is not even checked.
            $users['users'][$i]['failed_logins'] = $fails;
            $c->saveUsers($users);
            throw (new ApiError('ACCOUNT_LOCKED', 423, null, ['until' => $entry['until']]))->committing();
        }
        $ok = password_verify($password, (string) $u['password_hash']);
        if (!$ok || empty($u['active'])) {
            if ($ok || empty($u['active'])) {
                throw new ApiError('BAD_CREDENTIALS', 401); // inactive user: no counting
            }
            $n = (int) ($entry['n'] ?? 0) + 1;
            $entry = ['n' => $n, 'until' => null, 'last' => $c->nowIso];
            if ($n >= self::MAX_FAILS) {
                $entry['until'] = Clock::iso($c->now->modify('+' . self::LOCK_MINUTES . ' minutes'));
            }
            $fails[$ip] = $entry;
            $users['users'][$i]['failed_logins'] = $fails;
            $c->saveUsers($users);
            if ($entry['until'] !== null) {
                throw (new ApiError('ACCOUNT_LOCKED', 423, null, ['until' => $entry['until']]))->committing();
            }
            throw (new ApiError('BAD_CREDENTIALS', 401))->committing();
        }
        unset($fails[$ip]);
        $users['users'][$i]['failed_logins'] = $fails;
        if (password_needs_rehash((string) $u['password_hash'], PASSWORD_DEFAULT)) {
            $users['users'][$i]['password_hash'] = self::hash($password);
        }
        $c->saveUsers($users);
        $c->user = $users['users'][$i];
        return ['token' => self::tokenFor($c, $c->user), 'user' => self::publicUser($c->user)];
    }

    /** GET /api/me */
    public static function me(Ctx $c): array
    {
        return self::publicUser($c->user);
    }

    /** PATCH /api/me {"lang":"zh"|"en"} */
    public static function patchMe(Ctx $c): array
    {
        V::only($c->body, ['lang']);
        $users = $c->users();
        $i = self::indexById($users, $c->user['id']);
        if (array_key_exists('lang', $c->body)) {
            $users['users'][$i]['lang'] = V::enum($c->body['lang'], 'lang', self::LANGS);
        }
        $c->saveUsers($users);
        $c->user = $users['users'][$i];
        return self::publicUser($c->user);
    }

    /** POST /api/me/password {"old","new"} -> {"token"} (bumps token_version, clears must_change_password). */
    public static function changePassword(Ctx $c): array
    {
        V::only($c->body, ['old', 'new']);
        V::required($c->body, ['old', 'new']);
        $users = $c->users();
        $i = self::indexById($users, $c->user['id']);
        $u = $users['users'][$i];
        if (!is_string($c->body['old']) || !password_verify($c->body['old'], (string) $u['password_hash'])) {
            // 422, not 401: a 401 would make the client think the session ended.
            throw new ApiError('BAD_CREDENTIALS', 422, 'old', null, 'The current password is wrong');
        }
        $new = self::checkNewPassword($c->body['new'], 'new');
        $u['password_hash'] = self::hash($new);
        $u['must_change_password'] = false;
        $u['token_version'] = (int) ($u['token_version'] ?? 0) + 1;
        $users['users'][$i] = $u;
        $c->saveUsers($users);
        $c->user = $u;
        if ($u['id'] === 1) {
            $c->afterCommit(static function (Ctx $c): void {
                if ($c->store() instanceof FileStore) {
                    $c->store()->removeInitialAdminFile();
                }
            });
        }
        return ['token' => self::tokenFor($c, $u)];
    }

    /** POST /api/me/logout-all -> 204 (bumps token_version: every token of this user stops working). */
    public static function logoutAll(Ctx $c): mixed
    {
        $users = $c->users();
        $i = self::indexById($users, $c->user['id']);
        $users['users'][$i]['token_version'] = (int) ($users['users'][$i]['token_version'] ?? 0) + 1;
        $c->saveUsers($users);
        return $c->noContent();
    }
}
