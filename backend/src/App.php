<?php
// Front controller logic (§11.2): method+path router, JSON envelope, body read before the lock (R35),
// one locked transaction per request (R36), clock read once after the lock (R1), before_request hooks
// (R13 freeze, R16 seed import), auth + role check (R33), audit line (R36), security headers.
//
// ROUTES are modular: every file src/routes/*.php returns a list of entries
//     [METHOD, '/api/path/{param}', handler, roles, options?]
//   handler  callable fn(Ctx $c): mixed — a closure, [Class::class, 'method'] or 'Class::method'
//   roles    'public' (no token) | 'any' (any signed-in user) | ['admin','office'] | ['driver'] …
//   pattern  {name} matches one path segment; {name:regex} uses a custom regex (e.g. {id:\d+}).
//            Routes without parameters are matched first, then the others in file-name order.
//   options  'pwchange' => true   allowed while must_change_password (only /api/me, /api/me/password)
//            'raw'      => true   body is not JSON: use $c->req->body; read up to 'max_body' bytes
//                                 (default max_jpeg_bytes) BEFORE the lock (R35)
//            'unlocked' => true   auth + before_request hooks run in a short locked section, then the
//                                 handler runs OUTSIDE the lock with $c->tx = null (blob I/O, R35/R36)
//            'nolock'   => true   public only: no lock, no data access at all (GET /api/health)
// Adding the same METHOD + pattern twice throws at load time.
final class App
{
    /** @var list<array{method:string,pattern:string,regex:?string,handler:callable,roles:string|array,opts:array}> */
    private array $routes = [];

    /** Tests: inject "now" (bypasses fake_now) and observe the first clock read. */
    public ?DateTimeImmutable $fixedNow = null;
    public ?Closure $onClockRead = null;

    /** The last request's context (tests and debugging). */
    public ?Ctx $lastCtx = null;

    public function __construct(public array $config, public Store $store)
    {
    }

    public static function create(array $config, ?Store $store = null): self
    {
        $app = new self($config, $store ?? new FileStore($config));
        Hooks::reset();
        Hooks::loadDir(__DIR__ . '/hooks');
        $files = glob(__DIR__ . '/routes/*.php') ?: [];
        sort($files);
        foreach ($files as $file) {
            $entries = require $file;
            if (!is_array($entries)) {
                throw new LogicException("$file must return a list of routes");
            }
            foreach ($entries as $i => $e) {
                if (!is_array($e) || count($e) < 4) {
                    throw new LogicException("Bad route #$i in $file");
                }
                $app->addRoute($e[0], $e[1], $e[2], $e[3], $e[4] ?? []);
            }
        }
        return $app;
    }

    public function addRoute(string $method, string $pattern, callable|array|string $handler, string|array $roles, array $opts = []): void
    {
        $method = strtoupper($method);
        foreach ($this->routes as $r) {
            if ($r['method'] === $method && $r['pattern'] === $pattern) {
                throw new LogicException("Duplicate route $method $pattern");
            }
        }
        if (!is_callable($handler)) {
            throw new LogicException("Handler for $method $pattern is not callable");
        }
        $regex = null;
        if (str_contains($pattern, '{')) {
            $regex = '#^' . preg_replace_callback('/\{([a-z_][a-z0-9_]*)(?::([^}]+))?\}/i', static function ($m) {
                return '(?P<' . $m[1] . '>' . (($m[2] ?? '') !== '' ? $m[2] : '[^/]+') . ')';
            }, $pattern) . '$#';
        }
        if (!empty($opts['nolock']) && $roles !== 'public') {
            throw new LogicException("'nolock' routes must be public: $method $pattern");
        }
        $this->routes[] = compact('method', 'pattern', 'regex', 'handler', 'roles', 'opts');
    }

    /** @return array{0:?array,1:array<string,string>} [route|null, params] */
    public function match(string $method, string $path): array
    {
        $method = strtoupper($method);
        if ($method === 'HEAD') {
            $method = 'GET';
        }
        foreach ($this->routes as $r) {
            if ($r['regex'] === null && $r['method'] === $method && $r['pattern'] === $path) {
                return [$r, []];
            }
        }
        foreach ($this->routes as $r) {
            if ($r['regex'] !== null && $r['method'] === $method && preg_match($r['regex'], $path, $m)) {
                $params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY);
                return [$r, $params];
            }
        }
        return [null, []];
    }

    /** How many body bytes index.php reads for this request (+1 to detect "too large"). */
    public function maxBody(string $method, string $path): int
    {
        [$route] = $this->match($method, $path);
        if ($route !== null && !empty($route['opts']['raw'])) {
            return (int) ($route['opts']['max_body'] ?? $this->config['max_jpeg_bytes']);
        }
        return (int) $this->config['max_json_bytes'];
    }

    /** index.php entry point. */
    public function run(): void
    {
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $path = rawurldecode((string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?? '/'));
        $req = Request::fromGlobals($this->maxBody($method, $path));
        $this->handle($req)->send();
    }

    public function handle(Request $req): Response
    {
        $c = null;
        try {
            [$route, $params] = $this->match($req->method, $req->path);
            if ($route === null) {
                throw new ApiError('NOT_FOUND', 404, null, null, 'No such endpoint: ' . $req->method . ' ' . $req->path);
            }
            $opts = $route['opts'];

            $body = [];
            if (empty($opts['raw'])) {
                $raw = $req->body ?? '';
                if (strlen($raw) > (int) $this->config['max_json_bytes']) {
                    throw new ApiError('VALIDATION', 413, null, null, 'The request body is larger than 1 MB');
                }
                if (trim($raw) !== '') {
                    $body = json_decode($raw, true);
                    if (!is_array($body) || (array_is_list($body) && $body !== [])) {
                        throw new ApiError('VALIDATION', 400, null, null, 'The body must be a JSON object');
                    }
                }
            }

            $clock = new Clock($this->config, $this->fixedNow);
            $clock->onFirstRead = $this->onClockRead;
            if ($this->store instanceof FileStore) {
                $this->store->setClock($clock);
            }
            $c = new Ctx($this, $req, $clock);
            $this->lastCtx = $c;
            $c->params = $params;
            $c->body = $body;

            if (!empty($opts['nolock'])) {
                $c->now = $clock->now();
                $c->nowIso = Clock::iso($c->now);
                return $this->respond($c, ($route['handler'])($c));
            }

            $result = $this->store->transaction(function (Tx $tx) use ($c, $route, $opts) {
                $c->tx = $tx;
                try {
                    $this->begin($c);
                    $this->authorize($c, $route);
                    if (!empty($opts['unlocked'])) {
                        return ['data' => null];
                    }
                    return ['data' => ($route['handler'])($c)];
                } catch (ApiError $e) {
                    if ($e->commit) {
                        return ['error' => $e];
                    }
                    throw $e;
                }
            });
            if (isset($result['error'])) {
                $c->runAfterCommit(); // the documents were committed with the error (e.g. login counter)
                throw $result['error'];
            }
            $data = $result['data'];
            if (!empty($opts['unlocked'])) {
                $c->tx = null;
                $data = ($route['handler'])($c);
            }
            $c->runAfterCommit();
            $response = $this->respond($c, $data);
            $this->auditLine($c, $route, $response->status);
            return $response;
        } catch (ApiError $e) {
            return Http::error($e);
        } catch (Throwable $e) {
            error_log('WMS ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine()
                . "\n" . $e->getTraceAsString());
            return Http::error(new ApiError('INTERNAL', 500, null, null, 'Server error'));
        }
    }

    /** Clock once (after the lock), today from plan.settings.rollover_hour, then before_request hooks. */
    private function begin(Ctx $c): void
    {
        $c->now = $c->clock->now();
        $c->nowIso = Clock::iso($c->now);
        $plan = $c->tx->get('plan');
        $c->rollover = (int) ($plan['settings']['rollover_hour'] ?? Seed::DEFAULT_ROLLOVER_HOUR);
        $c->today = Clock::opDate($c->now, $c->rollover);
        Hooks::run(Hooks::BEFORE_REQUEST, $c);
    }

    private function authorize(Ctx $c, array $route): void
    {
        $roles = $route['roles'];
        if ($roles === 'public') {
            return;
        }
        $token = $c->req->bearer();
        $user = $token === null ? null : Auth::userFromToken($c, $token);
        if ($user === null) {
            throw new ApiError('UNAUTHORIZED', 401);
        }
        $c->user = $user;
        if (!empty($user['must_change_password']) && empty($route['opts']['pwchange'])) {
            throw new ApiError('PASSWORD_CHANGE_REQUIRED', 403);
        }
        if ($roles !== 'any' && !in_array($user['role'], (array) $roles, true)) {
            throw new ApiError('FORBIDDEN', 403);
        }
    }

    private function respond(Ctx $c, mixed $data): Response
    {
        if ($data instanceof Response) {
            $data->headers += Http::SECURITY_HEADERS;
            return $data;
        }
        if ($c->status === 204) {
            return Response::json(204, null);
        }
        return Http::ok($data, $c->warnings, $c->status);
    }

    /** One line per successful non-GET request (R36). password/old/new are removed; file bytes never logged. */
    private function auditLine(Ctx $c, array $route, int $status): void
    {
        if (in_array($c->req->method, ['GET', 'HEAD'], true) || $status >= 400) {
            return;
        }
        $path = $c->req->path;
        if ($c->req->query) {
            $path .= '?' . http_build_query($c->req->query);
        }
        $this->store->audit(array_merge([
            'at' => $c->nowIso,
            'user_id' => $c->user['id'] ?? null,
            'username' => $c->user['username'] ?? null,
            'method' => $c->req->method,
            'path' => $path,
            'status' => $status,
            'body' => empty($route['opts']['raw']) ? Http::redact($c->body) : null,
        ], $c->auditExtra));
    }
}
