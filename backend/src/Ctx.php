<?php
// Per-request context handed to every handler: fn(Ctx $c): mixed.
// The return value becomes "data" in the success envelope (status $c->status, default 200);
// return a Response to send something else (e.g. file bytes). Throw ApiError for errors.
final class Ctx
{
    /** @var array<string,string> path parameters */
    public array $params = [];
    /** @var array decoded JSON body ([] when empty; raw routes: use $req->body) */
    public array $body = [];
    /** The authenticated user record from users.json (includes password_hash: never output it; use Auth::publicUser). */
    public ?array $user = null;
    /** Null only inside an 'unlocked' route handler. */
    public ?Tx $tx = null;
    /** "now", read once per request after the lock (R1, R36). */
    public DateTimeImmutable $now;
    public string $nowIso = '';
    /** op_date(now) (R1). Every "today" in the backend comes from here. */
    public string $today = '';
    /** plan.settings.rollover_hour at request start. */
    public int $rollover = Seed::DEFAULT_ROLLOVER_HOUR;
    public int $status = 200;
    /** @var list<array{code:string,message:string}> */
    public array $warnings = [];
    /** Extra info for the audit line (merged into it). */
    public array $auditExtra = [];
    /** @var list<callable> */
    private array $afterCommit = [];

    public function __construct(public App $app, public Request $req, public Clock $clock)
    {
    }

    public function config(string $key): mixed
    {
        return $this->app->config[$key] ?? null;
    }

    public function store(): Store
    {
        return $this->app->store;
    }

    public function dataDir(): string
    {
        return rtrim((string) $this->app->config['data_dir'], '/');
    }

    public function param(string $name): string
    {
        return $this->params[$name] ?? '';
    }

    /** A positive integer path parameter; 404 NOT_FOUND otherwise. */
    public function intParam(string $name): int
    {
        $v = $this->param($name);
        if (!preg_match('/^[1-9][0-9]{0,9}$/', $v)) {
            throw new ApiError('NOT_FOUND', 404, $name);
        }
        return (int) $v;
    }

    /** A YYYY-MM-DD path parameter; 422 VALIDATION otherwise. */
    public function dateParam(string $name): string
    {
        $v = $this->param($name);
        if (!Dates::valid($v)) {
            throw new ApiError('VALIDATION', 422, $name, null, 'Expected a date YYYY-MM-DD');
        }
        return $v;
    }

    public function query(string $name, ?string $default = null): ?string
    {
        $v = $this->req->query[$name] ?? null;
        return is_string($v) ? $v : $default;
    }

    /** Query flags like release_run=1 / archived=0. */
    public function queryBool(string $name, bool $default = false): bool
    {
        $v = $this->query($name);
        if ($v === null || $v === '') {
            return $default;
        }
        return in_array(strtolower($v), ['1', 'true', 'yes'], true);
    }

    public function plan(): array
    {
        return $this->tx->get('plan');
    }

    /**
     * Every plan write goes through here: runs the plan_write hooks (R26 run invariant, R9 cleanup …),
     * then puts plan.json. $opts: ['release_run' => bool].
     */
    public function savePlan(array $plan, array $opts = []): void
    {
        $before = $this->tx->get('plan');
        foreach (Hooks::listeners(Hooks::PLAN_WRITE) as $fn) {
            $fn($this, $before, $plan, $opts);
        }
        $this->tx->put('plan', $plan);
    }

    public function users(): array
    {
        return $this->tx->get('users');
    }

    public function saveUsers(array $users): void
    {
        $this->tx->put('users', $users);
    }

    public function warn(string $code, ?string $message = null): void
    {
        $this->warnings[] = ['code' => $code, 'message' => $message ?? Http::message($code)];
    }

    public function created(mixed $data): mixed
    {
        $this->status = 201;
        return $data;
    }

    public function noContent(): mixed
    {
        $this->status = 204;
        return null;
    }

    /** Runs after the transaction committed successfully (e.g. delete a file, write a log line). */
    public function afterCommit(callable $fn): void
    {
        $this->afterCommit[] = $fn;
    }

    public function runAfterCommit(): void
    {
        foreach ($this->afterCommit as $fn) {
            $fn($this);
        }
        $this->afterCommit = [];
    }

    public function userId(): ?int
    {
        return $this->user['id'] ?? null;
    }

    /** 'user:<id>' (R30 principal). */
    public function principal(): string
    {
        return 'user:' . ($this->user['id'] ?? 0);
    }

    public function hasRole(string ...$roles): bool
    {
        return $this->user !== null && in_array($this->user['role'], $roles, true);
    }
}
