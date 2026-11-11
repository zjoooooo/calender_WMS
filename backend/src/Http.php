<?php
// Request parsing, responses, the JSON envelope and ApiError (§10.1).

/**
 * A rule or request error that becomes the error envelope:
 * {"ok":false,"error":{"code","message","field","details"}}.
 * Throw it from any handler: the transaction is rolled back and nothing is written,
 * unless $commit is true (used by login to persist the failed-login counter).
 */
final class ApiError extends RuntimeException
{
    public string $errorCode;
    public int $http;
    public ?string $field;
    public mixed $details;
    public bool $commit = false;

    public function __construct(string $code, int $http = 422, ?string $field = null, mixed $details = null, ?string $message = null)
    {
        parent::__construct($message ?? Http::message($code));
        $this->errorCode = $code;
        $this->http = $http;
        $this->field = $field;
        $this->details = $details;
    }

    /** Keep the documents written so far (the response is still this error). */
    public function committing(): self
    {
        $this->commit = true;
        return $this;
    }
}

final class Request
{
    /** @param array<string,string> $headers lower-case names */
    public function __construct(
        public string $method,
        public string $path,
        public array $query = [],
        public array $headers = [],
        public ?string $body = null,
        public string $ip = '',
    ) {
        $this->method = strtoupper($method);
        $lower = [];
        foreach ($headers as $k => $v) {
            $lower[strtolower((string) $k)] = (string) $v;
        }
        $this->headers = $lower;
    }

    /** Builds the request from PHP globals. Reads at most $maxBody + 1 bytes of body (R35). */
    public static function fromGlobals(int $maxBody): self
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = rawurldecode((string) (parse_url($uri, PHP_URL_PATH) ?? '/'));
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (is_string($v) && str_starts_with($k, 'HTTP_')) {
                $headers[str_replace('_', '-', strtolower(substr($k, 5)))] = $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        if (isset($_SERVER['CONTENT_LENGTH'])) {
            $headers['content-length'] = (string) $_SERVER['CONTENT_LENGTH'];
        }
        if (!isset($headers['authorization'])) {
            $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
            if ($auth === null && function_exists('getallheaders')) {
                foreach (getallheaders() as $k => $v) {
                    if (strtolower($k) === 'authorization') {
                        $auth = $v;
                    }
                }
            }
            if (is_string($auth)) {
                $headers['authorization'] = $auth;
            }
        }
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $body = null;
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            $in = fopen('php://input', 'rb');
            if ($in !== false) {
                $read = stream_get_contents($in, $maxBody + 1);
                fclose($in);
                $body = $read === false ? '' : $read;
            }
        }
        $query = [];
        foreach ($_GET as $k => $v) {
            if (is_string($v)) {
                $query[(string) $k] = $v;
            }
        }
        return new self($method, $path, $query, $headers, $body, (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function bearer(): ?string
    {
        $h = $this->header('authorization');
        if ($h !== null && preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) {
            return $m[1];
        }
        return null;
    }
}

final class Response
{
    /** @param array<string,string> $headers */
    public function __construct(
        public int $status = 200,
        public array $headers = [],
        public string $body = '',
        public ?Closure $stream = null,
    ) {
    }

    public static function json(int $status, mixed $payload): self
    {
        $headers = Http::SECURITY_HEADERS + [
            'Content-Type' => 'application/json; charset=utf-8',
            'Cache-Control' => 'no-store',
        ];
        if ($status === 204) {
            unset($headers['Content-Type']);
            return new self(204, $headers, '');
        }
        return new self($status, $headers, Http::encode($payload));
    }

    /** Decoded JSON body (tests). */
    public function data(): mixed
    {
        return $this->body === '' ? null : json_decode($this->body, true);
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) {
            header($k . ': ' . $v);
        }
        if ($this->stream !== null) {
            ($this->stream)();
            return;
        }
        echo $this->body;
    }
}

final class Http
{
    public const SECURITY_HEADERS = [
        'X-Content-Type-Options' => 'nosniff',
        'X-Frame-Options' => 'DENY',
        'Referrer-Policy' => 'same-origin',
        'Content-Security-Policy' => "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    ];

    public const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;

    /** Default English messages; the frontend maps every code to its own zh/en text (§10.11). */
    private const MESSAGES = [
        'VALIDATION' => 'Invalid request',
        'NOT_FOUND' => 'Not found',
        'UNAUTHORIZED' => 'Please sign in',
        'FORBIDDEN' => 'Not allowed for your role',
        'INTERNAL' => 'Server error',
        'BAD_CREDENTIALS' => 'Wrong username or password',
        'ACCOUNT_LOCKED' => 'Too many wrong passwords: try again later',
        'PASSWORD_CHANGE_REQUIRED' => 'Please set a new password first',
        'PASSWORD_TOO_SHORT' => 'The password must have at least 8 characters',
        'USERNAME_TAKEN' => 'This username is taken',
        'LAST_ADMIN' => 'The last active admin cannot be deactivated or demoted',
        'PAST_DATE_LOCKED' => 'Dates before today cannot be changed',
        'HOLIDAY_CONFLICT' => 'A one-off route would become illegal on this date',
        'RUN_EXISTS' => 'A driver has already started this job',
        'WASTE_TYPES_REQUIRED' => 'Pick at least one waste type',
        'UNKNOWN_WASTE_TYPE' => 'Unknown or inactive waste type',
        'WASTE_TYPE_IN_USE' => 'This waste type is still in use',
        'CUSTOMER_IN_USE' => 'This customer is still on routes or tasks',
        'ROLLOVER_SHIFTS_TODAY' => 'This change would move today: try again later',
        'DATA_CORRUPT' => 'A data file cannot be read: restore it from its .bak copy',
        'CLOCK_BEHIND_FREEZE' => 'The server clock is behind the frozen days',
        'FILE_TOO_LARGE' => 'The file is too large',
        // Plan (routes, tasks)
        'TYPE_IMMUTABLE' => 'A route type cannot be changed',
        'WEEKDAY_NOT_ALLOWED' => 'Regular routes run Monday to Saturday only',
        'DAY_CLASS_VIOLATION' => 'This route type is not allowed on this kind of day',
        'NOT_AN_OCCURRENCE' => 'The route or task does not run on this date',
        'DUPLICATE_STOP' => 'This customer is already on the list',
        'CUSTOMER_INACTIVE' => 'This customer is archived',
        'CUSTOMER_NOT_ROUTABLE' => 'Only customers with a route waste type (REL) can be on a route',
        'CODE_IN_USE' => 'Another route uses this code in the same period',
        'STALE_REVISION' => 'Someone else changed this meanwhile: reload and try again',
        'TYPE_ROUTABLE' => 'This waste type is collected on routes, not by tasks',
        'CUSTOMER_LACKS_TYPE' => 'The customer is not registered for this waste type',
        'RECURRING_NOT_ALLOWED' => 'This waste type allows one-off tasks only',
        'TASK_FIELD_IMMUTABLE' => 'Type, customer and kind of a task cannot be changed: create a new task',
        'EMPTY_ROUTE' => 'The route has no customers',
        // Runs and visits (R21-R30), files (R35)
        'NOT_TODAY' => 'This job is not today\'s',
        'NOT_RUNNABLE' => 'This job cannot be taken (not scheduled, no stops, or already done)',
        'RUN_TAKEN' => 'Another driver has this job',
        'DRIVER_HAS_ACTIVE_RUN' => 'You already have a route with stops left',
        'NOT_HOLDER' => 'You do not have this job',
        'VEHICLE_REQUIRED' => 'Pick your truck plate',
        'VEHICLE_UNKNOWN' => 'This truck plate is not in the vehicle list',
        'VISIT_CHANGED' => 'This result was changed by someone else meanwhile',
        'NOT_ON_JOB' => 'This customer is not on this job',
        'TYPE_NOT_ALLOWED' => 'This waste type cannot be weighed here',
        'WEIGHT_INVALID' => 'Enter a weight from 0 to 99999.9 with at most 1 decimal',
        'WEIGHT_REQUIRED' => 'Enter at least one weight above 0',
        'TICKET_REQUIRED' => 'Enter the weighbridge ticket number',
        'REASON_REQUIRED' => 'Describe the reason in the note',
        'WHY_REQUIRED' => 'Say why the result is changed',
        'EDIT_WINDOW_CLOSED' => 'This result can no longer be changed by the driver: call the office',
        'FILE_MISSING' => 'A photo or signature has not been uploaded yet',
        'FILE_INVALID' => 'The file is not a valid JPEG or PNG',
        'OFF_PLAN' => 'Recorded for a customer that is no longer on the stop list',
        'LATE' => 'Recorded after the day closed or after the job was handed over',
    ];

    public static function message(string $code): string
    {
        return self::MESSAGES[$code] ?? $code;
    }

    public static function encode(mixed $data): string
    {
        return json_encode($data, self::JSON_FLAGS);
    }

    /** @param list<array{code:string,message:string}> $warnings */
    public static function ok(mixed $data, array $warnings = [], int $status = 200): Response
    {
        return Response::json($status, ['ok' => true, 'data' => $data, 'warnings' => $warnings]);
    }

    public static function error(ApiError $e): Response
    {
        return Response::json($e->http, ['ok' => false, 'error' => [
            'code' => $e->errorCode,
            'message' => $e->getMessage(),
            'field' => $e->field,
            'details' => $e->details,
        ]]);
    }

    /** Removes the keys password, old and new at any depth (audit log, R36). */
    public static function redact(mixed $body): mixed
    {
        if (!is_array($body)) {
            return $body;
        }
        $out = [];
        foreach ($body as $k => $v) {
            if (is_string($k) && in_array($k, ['password', 'old', 'new'], true)) {
                continue;
            }
            $out[$k] = self::redact($v);
        }
        return $out;
    }
}
