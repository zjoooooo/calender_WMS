<?php
// Shared test helpers: TestEnv (a temp data dir + the App driven in-process with an injected "now")
// and T (assertions + subset matching). Used by tests/run.php for both tests/unit/*.php and
// tests/cases/*.json. Other parts of the team can reuse TestEnv in their own unit files.

final class TestFailure extends Exception
{
}

final class T
{
    public static int $assertions = 0;

    public static function fail(string $msg): never
    {
        throw new TestFailure($msg);
    }

    public static function true(mixed $cond, string $msg = 'expected true'): void
    {
        self::$assertions++;
        if ($cond !== true) {
            self::fail($msg);
        }
    }

    public static function eq(mixed $expected, mixed $actual, string $msg = ''): void
    {
        self::$assertions++;
        if ($expected !== $actual) {
            self::fail(($msg !== '' ? "$msg: " : '') . 'expected ' . self::show($expected) . ', got ' . self::show($actual));
        }
    }

    /** Asserts a TestEnv::call() result is a success with $status; returns data. */
    public static function ok(array $res, int $status = 200): mixed
    {
        self::$assertions++;
        if ($res['status'] !== $status || ($status !== 204 && ($res['json']['ok'] ?? null) !== true)) {
            self::fail("expected $status ok, got {$res['status']} " . self::show($res['json']));
        }
        return $res['json']['data'] ?? null;
    }

    /** Asserts an error envelope with $status and $code; returns the error object. */
    public static function err(array $res, int $status, string $code): array
    {
        self::$assertions++;
        $got = $res['json']['error']['code'] ?? null;
        if ($res['status'] !== $status || $got !== $code) {
            self::fail("expected $status $code, got {$res['status']} " . self::show($res['json']));
        }
        return $res['json']['error'];
    }

    /** Asserts $actual matches $expected as a subset (see subset()). */
    public static function subset(mixed $expected, mixed $actual, string $msg = ''): void
    {
        self::$assertions++;
        $why = self::mismatch($expected, $actual, '$');
        if ($why !== null) {
            self::fail(($msg !== '' ? "$msg: " : '') . $why);
        }
    }

    /**
     * Subset rules: objects match when every expected key matches; lists match element-wise with the
     * same length; numbers compare by value (2410 == 2410.0). Operators (as a one-key object):
     *   {"$absent": true}        the key must not exist
     *   {"$contains": [x, …]}    every x matches some element of the actual list
     *   {"$not_contains": [x…]}  no x matches any element
     *   {"$len": n}              the actual list/object has n elements
     *   {"$any": true}           anything (the key must exist)
     */
    public static function mismatch(mixed $exp, mixed $act, string $path): ?string
    {
        if (is_array($exp) && count($exp) === 1 && is_string(array_key_first($exp)) && str_starts_with(array_key_first($exp), '$')) {
            $op = array_key_first($exp);
            $arg = $exp[$op];
            switch ($op) {
                case '$any':
                    return null;
                case '$len':
                    return is_array($act) && count($act) === $arg ? null : "$path: expected length $arg, got " . self::show($act);
                case '$contains':
                case '$not_contains':
                    if (!is_array($act)) {
                        return "$path: expected a list, got " . self::show($act);
                    }
                    foreach ($arg as $want) {
                        $found = false;
                        foreach ($act as $item) {
                            if (self::mismatch($want, $item, $path) === null) {
                                $found = true;
                                break;
                            }
                        }
                        if ($op === '$contains' && !$found) {
                            return "$path: no element matches " . self::show($want) . ' in ' . self::show($act);
                        }
                        if ($op === '$not_contains' && $found) {
                            return "$path: an element matches " . self::show($want);
                        }
                    }
                    return null;
            }
        }
        if (is_array($exp)) {
            if (!is_array($act)) {
                return "$path: expected " . self::show($exp) . ', got ' . self::show($act);
            }
            if (array_is_list($exp) && $exp !== []) {
                if (!array_is_list($act) || count($act) !== count($exp)) {
                    return "$path: expected list " . self::show($exp) . ', got ' . self::show($act);
                }
            }
            if ($exp === [] && $act !== []) {
                return "$path: expected empty, got " . self::show($act);
            }
            foreach ($exp as $k => $v) {
                if (is_array($v) && array_key_exists('$absent', $v)) {
                    if (array_key_exists($k, $act)) {
                        return "$path.$k: expected absent, got " . self::show($act[$k]);
                    }
                    continue;
                }
                if (!array_key_exists($k, $act)) {
                    return "$path.$k: missing";
                }
                $why = self::mismatch($v, $act[$k], "$path.$k");
                if ($why !== null) {
                    return $why;
                }
            }
            return null;
        }
        if ((is_int($exp) || is_float($exp)) && (is_int($act) || is_float($act))) {
            return $exp == $act ? null : "$path: expected $exp, got $act";
        }
        return $exp === $act ? null : "$path: expected " . self::show($exp) . ', got ' . self::show($act);
    }

    public static function show(mixed $v): string
    {
        $s = json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        return strlen((string) $s) > 400 ? substr($s, 0, 400) . '…' : (string) $s;
    }
}

final class TestEnv
{
    public const PASSWORD = 'password1';

    public string $dir;
    public array $config;
    public App $app;
    private static int $n = 0;
    /** @var list<string> data dirs not cleaned up yet (run.php removes them after each test) */
    public static array $open = [];
    /** @var array<string,string> */
    private static array $hashes = [];

    /** Fast bcrypt for test users (cost 4), cached per password. */
    public static function hash(string $password): string
    {
        return self::$hashes[$password] ??= password_hash($password, PASSWORD_BCRYPT, ['cost' => 4]);
    }

    public static function user(int $id, string $username, string $role, array $extra = []): array
    {
        $password = $extra['password'] ?? self::PASSWORD;
        unset($extra['password']);
        return array_merge([
            'id' => $id, 'username' => $username, 'name' => ucfirst($username), 'role' => $role, 'lang' => 'en',
            'password_hash' => self::hash($password), 'must_change_password' => false, 'active' => true,
            'token_version' => 1, 'failed_logins' => [],
        ], $extra);
    }

    /** admin (1, admin), mei (2, office), ali (3, driver), bala (4, driver); password TestEnv::PASSWORD. */
    public static function defaultUsers(): array
    {
        return [
            self::user(1, 'admin', 'admin'),
            self::user(2, 'mei', 'office'),
            self::user(3, 'ali', 'driver'),
            self::user(4, 'bala', 'driver'),
        ];
    }

    /**
     * A temp data dir with a .demo marker. $given:
     *   fixture     name of tests/fixtures/<name>.json (a "given" object merged under this one)
     *   plan        partial plan: its top-level keys replace those of the seed plan for $now
     *   users       list of user records (a "password" key is hashed for you); default defaultUsers()
     *   days        {"2026-11-11": day doc}
     *   files       {"relative/path": "content"} extra raw files (e.g. a corrupt plan.json)
     *   first_start true: leave the data dir empty (the first request seeds it)
     *   demo        false: no .demo marker
     *   config      config overrides
     */
    public static function make(string $now, array $given = []): self
    {
        if (isset($given['fixture'])) {
            // tests/fixtures/<name>.json holds a "given" object; the case's own plan keys / days win.
            $fx = json_decode((string) file_get_contents(__DIR__ . '/fixtures/' . $given['fixture'] . '.json'), true);
            $given['plan'] = array_replace($fx['plan'] ?? [], $given['plan'] ?? []);
            $given['days'] = array_replace($fx['days'] ?? [], $given['days'] ?? []);
            $given += $fx;
        }
        $env = new self();
        $env->dir = rtrim(sys_get_temp_dir(), '/') . '/wms-test-' . getmypid() . '-' . (++self::$n);
        self::rmrf($env->dir);
        self::$open[] = $env->dir;
        mkdir($env->dir, 0777, true);
        if (($given['demo'] ?? true) === true) {
            touch($env->dir . '/.demo');
        }
        $base = $GLOBALS['WMS_TEST_CONFIG'];
        $env->config = array_replace($base, ['data_dir' => $env->dir, 'fake_now' => null], $given['config'] ?? []);
        if (empty($given['first_start'])) {
            $nowDt = new DateTimeImmutable($now);
            $planGiven = $given['plan'] ?? [];
            $h = (int) ($planGiven['settings']['rollover_hour'] ?? Seed::DEFAULT_ROLLOVER_HOUR);
            $plan = array_replace(Seed::plan(Clock::opDate($nowDt, $h), $env->config['seed_file']), $planGiven);
            file_put_contents($env->dir . '/plan.json', FileStore::encodeDoc($plan));
            $users = [];
            $maxId = 0;
            foreach ($given['users'] ?? self::defaultUsers() as $u) {
                if (isset($u['password'])) {
                    $u['password_hash'] = self::hash($u['password']);
                    unset($u['password']);
                }
                $u += self::user((int) $u['id'], (string) $u['username'], (string) $u['role']);
                $users[] = $u;
                $maxId = max($maxId, $u['id']);
            }
            file_put_contents($env->dir . '/users.json', FileStore::encodeDoc(['seq' => $maxId, 'users' => $users]));
            mkdir($env->dir . '/days');
            foreach ($given['days'] ?? [] as $date => $day) {
                file_put_contents("$env->dir/days/$date.json", FileStore::encodeDoc($day));
            }
            file_put_contents($env->dir . '/secret.key', bin2hex(random_bytes(32)) . "\n");
        }
        foreach ($given['files'] ?? [] as $rel => $content) {
            FileStore::ensureDir(dirname("$env->dir/$rel"));
            file_put_contents("$env->dir/$rel", $content);
        }
        $env->app = App::create($env->config);
        $env->setNow($now);
        return $env;
    }

    public function setNow(?string $iso): void
    {
        $this->app->fixedNow = $iso === null ? null : new DateTimeImmutable($iso);
    }

    /** A valid token for a user as stored now (current token_version), expiring 30 days after "now". */
    public function token(string $username): string
    {
        $users = json_decode((string) file_get_contents($this->dir . '/users.json'), true);
        $i = Auth::indexByUsername($users, $username);
        if ($i === null) {
            T::fail("no user $username");
        }
        $secret = trim((string) file_get_contents($this->dir . '/secret.key'));
        $now = $this->app->fixedNow ?? new DateTimeImmutable();
        return Auth::issueToken($users['users'][$i], $secret, $now->getTimestamp(), 30);
    }

    /**
     * Calls the API in-process. $as: a username (a token is made for it), 'token:<raw token>', or null.
     * $opt: ip, headers, raw (raw body string).
     * @return array{status:int,json:mixed,headers:array,response:Response}
     */
    public function call(string $method, string $path, ?array $body = null, ?string $as = null, array $opt = []): array
    {
        $query = [];
        if (str_contains($path, '?')) {
            [$path, $qs] = explode('?', $path, 2);
            parse_str($qs, $query);
        }
        $headers = $opt['headers'] ?? [];
        if ($as !== null) {
            $headers['Authorization'] = 'Bearer ' . (str_starts_with($as, 'token:') ? substr($as, 6) : $this->token($as));
        }
        $raw = $opt['raw'] ?? ($body === null ? null : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION));
        $req = new Request($method, $path, $query, $headers, $raw, $opt['ip'] ?? '10.0.0.1');
        $resp = $this->app->handle($req);
        return ['status' => $resp->status, 'json' => $resp->data(), 'headers' => $resp->headers, 'response' => $resp];
    }

    /**
     * Reads a document from disk: 'plan', 'users', 'day:YYYY-MM-DD', 'audit:YYYY-MM' (list of lines),
     * 'file:<relative path>' ({"exists": bool, "content": string|null}). Missing JSON docs return null.
     */
    public function doc(string $name): mixed
    {
        if (str_starts_with($name, 'file:')) {
            $f = $this->dir . '/' . substr($name, 5);
            return ['exists' => file_exists($f), 'content' => is_file($f) ? file_get_contents($f) : null];
        }
        if (str_starts_with($name, 'audit:')) {
            $f = $this->dir . '/audit/' . substr($name, 6) . '.jsonl';
            if (!is_file($f)) {
                return [];
            }
            return array_map(static fn ($l) => json_decode($l, true), array_values(array_filter(explode("\n", (string) file_get_contents($f)))));
        }
        $f = $name === 'plan' || $name === 'users' ? "$this->dir/$name.json" : "$this->dir/days/" . substr($name, 4) . '.json';
        return is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    }

    public function writeDoc(string $name, array $data): void
    {
        $f = $name === 'plan' || $name === 'users' ? "$this->dir/$name.json" : "$this->dir/days/" . substr($name, 4) . '.json';
        file_put_contents($f, FileStore::encodeDoc($data));
    }

    public function cleanup(): void
    {
        self::rmrf($this->dir);
        self::$open = array_values(array_diff(self::$open, [$this->dir]));
    }

    /** Removes every data dir a test left behind (also after a failure). */
    public static function cleanupAll(): void
    {
        foreach (self::$open as $dir) {
            self::rmrf($dir);
        }
        self::$open = [];
    }

    public static function rmrf(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        foreach (scandir($path) as $e) {
            if ($e !== '.' && $e !== '..') {
                self::rmrf("$path/$e");
            }
        }
        rmdir($path);
    }
}
