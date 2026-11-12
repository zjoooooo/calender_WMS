<?php
// JSON-file store (§4.1–4.3, R36): one exclusive flock on data/.lock per request, cached reads,
// atomic writes (temp file + fsync + rename), .bak copies of plan and users, DATA_CORRUPT for a
// document that does not decode, and the first-start seed.
final class FileStore implements Store, Tx
{
    public const FILE_JSON_FLAGS = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;

    private string $dir;
    /** @var resource|null */
    private $lockHandle = null;
    private bool $inTx = false;
    /** @var array<string,array> */
    private array $cache = [];
    /** @var array<string,array> documents as read (to skip unchanged writes) */
    private array $orig = [];
    /** @var array<string,bool> */
    private array $dirty = [];
    private ?Clock $clock = null;
    private ?string $secret = null;

    /** Called after a first-start seed with (password, path of initial-admin.txt). Default: print to stderr. */
    public ?Closure $onSeed = null;
    /** True when the current transaction seeded the data dir. */
    public bool $seeded = false;

    public function __construct(private array $config)
    {
        $this->dir = rtrim(str_replace('\\', '/', (string) $config['data_dir']), '/');
    }

    public function setClock(Clock $clock): void
    {
        $this->clock = $clock;
    }

    public function dataDir(): string
    {
        return $this->dir;
    }

    public function isLocked(): bool
    {
        return $this->lockHandle !== null;
    }

    /**
     * Runs $fn under the global lock WITHOUT a transaction or first-start seed
     * (tools such as backup.php take the same lock this way). Released in finally (FPM-safe).
     */
    public function lock(callable $fn): mixed
    {
        if ($this->lockHandle !== null) {
            throw new LogicException('The data lock is already held by this process');
        }
        self::ensureDir($this->dir);
        $h = fopen($this->dir . '/.lock', 'c');
        if ($h === false || !flock($h, LOCK_EX)) {
            throw new RuntimeException('Cannot lock ' . $this->dir . '/.lock');
        }
        $this->lockHandle = $h;
        try {
            return $fn();
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
            $this->lockHandle = null;
        }
    }

    public function transaction(callable $fn): mixed
    {
        if ($this->inTx) {
            throw new LogicException('Nested transaction');
        }
        return $this->lock(function () use ($fn) {
            $this->inTx = true;
            $this->cache = $this->orig = $this->dirty = [];
            $this->secret = null;
            $this->seeded = false;
            try {
                if ($this->isFirstStart()) {
                    $this->seed();
                }
                $result = $fn($this);
                $this->commit();
                return $result;
            } finally {
                $this->inTx = false;
                $this->cache = $this->orig = $this->dirty = [];
            }
        });
    }

    // ---- Tx ---------------------------------------------------------------------------------

    public function get(string $doc): array
    {
        $this->assertTx();
        if (array_key_exists($doc, $this->cache)) {
            return $this->cache[$doc];
        }
        $file = $this->fileFor($doc);
        if (!is_file($file)) {
            if (!str_starts_with($doc, 'day:')) {
                throw new ApiError('DATA_CORRUPT', 503, null, ['file' => $this->rel($file), 'reason' => 'missing']);
            }
            $data = self::emptyDay(substr($doc, 4));
        } else {
            $data = json_decode((string) file_get_contents($file), true);
            if (!is_array($data)) {
                throw new ApiError('DATA_CORRUPT', 503, null, ['file' => $this->rel($file), 'reason' => 'does not decode']);
            }
        }
        $this->cache[$doc] = $this->orig[$doc] = $data;
        return $data;
    }

    public function put(string $doc, array $data): void
    {
        $this->assertTx();
        $this->fileFor($doc); // validates the name
        $this->cache[$doc] = $data;
        $this->dirty[$doc] = true;
    }

    // ---- Store extras -------------------------------------------------------------------------

    public function secretKey(): string
    {
        if ($this->secret !== null) {
            return $this->secret;
        }
        $file = $this->dir . '/secret.key';
        $key = is_file($file) ? trim((string) file_get_contents($file)) : '';
        if (strlen($key) < 32) {
            // Missing (e.g. restored from an old backup): make a new one; every token becomes invalid (§4.2).
            $key = bin2hex(random_bytes(32));
            self::atomicWrite($file, $key . "\n");
        }
        return $this->secret = $key;
    }

    public function audit(array $line): void
    {
        $month = substr((string) ($line['at'] ?? date('Y-m')), 0, 7);
        $dir = $this->dir . '/audit';
        self::ensureDir($dir);
        file_put_contents($dir . '/' . $month . '.jsonl', Http::encode($line) . "\n", FILE_APPEND | LOCK_EX);
    }

    /** Deletes data/initial-admin.txt (after the first password change, R33). */
    public function removeInitialAdminFile(): void
    {
        $f = $this->dir . '/initial-admin.txt';
        if (is_file($f)) {
            unlink($f);
        }
    }

    public static function emptyDay(string $date): array
    {
        return ['date' => $date, 'plan' => null, 'runs' => [], 'dropped_runs' => [], 'submissions' => []];
    }

    // ---- internals ----------------------------------------------------------------------------

    private function assertTx(): void
    {
        if (!$this->inTx) {
            throw new LogicException('Store documents are only available inside transaction()');
        }
    }

    private function fileFor(string $doc): string
    {
        if ($doc === 'plan' || $doc === 'users') {
            return $this->dir . '/' . $doc . '.json';
        }
        if (str_starts_with($doc, 'day:') && Dates::valid(substr($doc, 4))) {
            return $this->dir . '/days/' . substr($doc, 4) . '.json';
        }
        throw new InvalidArgumentException("Unknown document '$doc'");
    }

    private function rel(string $file): string
    {
        return ltrim(substr($file, strlen($this->dir)), '/');
    }

    /** R36: a first start only when plan.json, plan.json.bak and days/ are all absent. */
    private function isFirstStart(): bool
    {
        return !file_exists($this->dir . '/plan.json')
            && !file_exists($this->dir . '/plan.json.bak')
            && !file_exists($this->dir . '/days');
    }

    private function seed(): void
    {
        $clock = $this->clock ?? new Clock($this->config);
        $today = Clock::opDate($clock->now(), Seed::DEFAULT_ROLLOVER_HOUR);
        $password = Seed::randomPassword();
        $this->secretKey();
        self::atomicWrite($this->dir . '/users.json', self::encodeDoc(Seed::users($password)));
        self::atomicWrite($this->dir . '/plan.json', self::encodeDoc(Seed::plan($today, (string) $this->config['seed_file'])));
        $adminFile = $this->dir . '/initial-admin.txt';
        self::atomicWrite($adminFile, "WMS first start: initial admin login. Change the password at the first login;\n"
            . "this file is deleted after that.\nusername: admin\npassword: $password\n");
        self::ensureDir($this->dir . '/days');
        $this->seeded = true;
        if ($this->onSeed !== null) {
            ($this->onSeed)($password, $adminFile);
        } else {
            $msg = "\n==================================================\n"
                . " WMS first start: data folder created at\n " . $this->dir . "\n"
                . " Admin login:  username admin   password $password\n"
                . " (also in initial-admin.txt; change it at first login)\n"
                . "==================================================\n";
            file_put_contents('php://stderr', $msg);
        }
    }

    private function commit(): void
    {
        $docs = array_keys($this->dirty);
        // Write order (R36): day files first, then users, then plan.
        usort($docs, static function (string $a, string $b): int {
            $rank = static fn (string $d): int => str_starts_with($d, 'day:') ? 0 : ($d === 'users' ? 1 : 2);
            return [$rank($a), $a] <=> [$rank($b), $b];
        });
        foreach ($docs as $doc) {
            $data = $this->cache[$doc];
            if (array_key_exists($doc, $this->orig) && $this->orig[$doc] === $data) {
                continue; // unchanged
            }
            $file = $this->fileFor($doc);
            if ($doc === 'plan' || $doc === 'users') {
                // Keep a .bak of the current version, but only when it decodes.
                if (is_file($file)) {
                    $current = (string) file_get_contents($file);
                    if (is_array(json_decode($current, true))) {
                        self::atomicWrite($file . '.bak', $current);
                    }
                }
            }
            self::atomicWrite($file, self::encodeDoc($data));
            $this->orig[$doc] = $data;
        }
        $this->dirty = [];
    }

    public static function encodeDoc(array $data): string
    {
        return json_encode($data, self::FILE_JSON_FLAGS) . "\n";
    }

    public static function ensureDir(string $dir): void
    {
        if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
            throw new RuntimeException("Cannot create directory $dir");
        }
    }

    /** Temp file in the same directory, fwrite + fflush + fsync, then rename over the target (R36). */
    public static function atomicWrite(string $file, string $content): void
    {
        $dir = dirname($file);
        self::ensureDir($dir);
        $tmp = $dir . '/.' . basename($file) . '.' . bin2hex(random_bytes(4)) . '.tmp';
        $h = fopen($tmp, 'xb');
        if ($h === false) {
            throw new RuntimeException("Cannot create $tmp");
        }
        try {
            $len = strlen($content);
            for ($done = 0; $done < $len;) {
                $n = fwrite($h, substr($content, $done));
                if ($n === false || $n === 0) {
                    throw new RuntimeException("Write failed: $tmp");
                }
                $done += $n;
            }
            fflush($h);
            fsync($h);
        } finally {
            fclose($h);
        }
        // Linux: rename(2) is atomic. Windows (local dev): retry 5 times, 50 ms apart.
        for ($i = 0; !@rename($tmp, $file); $i++) {
            if ($i >= 5) {
                @unlink($tmp);
                throw new RuntimeException("Cannot replace $file");
            }
            usleep(50000);
        }
    }
}
