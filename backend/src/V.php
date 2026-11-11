<?php
// Small validators for request bodies. Each throws ApiError (422 VALIDATION unless noted) naming the
// field. Text lengths use preg_match('/^.{min,max}$/us') (no mbstring, §11.1).
final class V
{
    /** Unknown fields are rejected with VALIDATION (§12). */
    public static function only(array $body, array $allowed): void
    {
        foreach (array_keys($body) as $k) {
            if (!in_array($k, $allowed, true)) {
                throw new ApiError('VALIDATION', 422, (string) $k, null, "Unknown field '$k'");
            }
        }
    }

    public static function required(array $body, array $keys): void
    {
        foreach ($keys as $k) {
            if (!array_key_exists($k, $body)) {
                throw new ApiError('VALIDATION', 422, $k, null, "Missing field '$k'");
            }
        }
    }

    public static function fail(string $field, string $message, string $code = 'VALIDATION', mixed $details = null): never
    {
        throw new ApiError($code, 422, $field, $details, $message);
    }

    /** A string of $min..$max characters (UTF-8). Trimmed unless $trim = false. */
    public static function str(mixed $v, string $field, int $min = 0, int $max = 200, bool $trim = true): string
    {
        if (!is_string($v)) {
            self::fail($field, "'$field' must be text");
        }
        if ($trim) {
            $v = trim($v);
        }
        if (!preg_match('//u', $v)) {
            self::fail($field, "'$field' is not valid UTF-8");
        }
        if (!preg_match('/^.{' . $min . ',' . $max . '}$/us', $v)) {
            self::fail($field, "'$field' must have $min to $max characters");
        }
        return $v;
    }

    /** Optional text: null/absent becomes ''. */
    public static function optStr(array $body, string $field, int $max = 200): string
    {
        $v = $body[$field] ?? '';
        return $v === null ? '' : self::str($v, $field, 0, $max);
    }

    public static function regex(mixed $v, string $field, string $re, string $message): string
    {
        if (!is_string($v) || !preg_match($re, $v)) {
            self::fail($field, $message);
        }
        return $v;
    }

    public static function bool(mixed $v, string $field): bool
    {
        if (!is_bool($v)) {
            self::fail($field, "'$field' must be true or false");
        }
        return $v;
    }

    public static function int(mixed $v, string $field, ?int $min = null, ?int $max = null): int
    {
        if (!is_int($v) || ($min !== null && $v < $min) || ($max !== null && $v > $max)) {
            self::fail($field, "'$field' must be a whole number" . ($min !== null && $max !== null ? " from $min to $max" : ''));
        }
        return $v;
    }

    public static function number(mixed $v, string $field, ?float $min = null, ?float $max = null): int|float
    {
        if (!is_int($v) && !is_float($v)) {
            self::fail($field, "'$field' must be a number");
        }
        if (($min !== null && $v < $min) || ($max !== null && $v > $max)) {
            self::fail($field, "'$field' is out of range");
        }
        return $v;
    }

    public static function enum(mixed $v, string $field, array $values): string
    {
        if (!is_string($v) || !in_array($v, $values, true)) {
            self::fail($field, "'$field' must be one of: " . implode(', ', $values));
        }
        return $v;
    }

    public static function date(mixed $v, string $field): string
    {
        if (!Dates::valid($v)) {
            self::fail($field, "'$field' must be a date YYYY-MM-DD");
        }
        return $v;
    }

    /** A positive integer id. */
    public static function id(mixed $v, string $field): int
    {
        if (!is_int($v) || $v < 1) {
            self::fail($field, "'$field' must be an id");
        }
        return $v;
    }

    /** @return list<mixed> */
    public static function list(mixed $v, string $field): array
    {
        if (!is_array($v) || !array_is_list($v)) {
            self::fail($field, "'$field' must be a list");
        }
        return $v;
    }
}
