<?php
// Storage interfaces (§4.2). FileStore implements both. A SqliteStore/MysqlStore can replace it
// later without touching rule code.

interface Store
{
    /**
     * Runs $fn(Tx $tx) under the global exclusive lock. Documents read through $tx are cached;
     * documents passed to put() are written atomically (day files, then users, then plan) when $fn
     * returns. If $fn throws, nothing is written.
     */
    public function transaction(callable $fn): mixed;

    /** The HMAC key for tokens (R34). Created when missing. Call inside a transaction. */
    public function secretKey(): string;

    /** Appends one line to the audit log (R36). */
    public function audit(array $line): void;
}

interface Tx
{
    /** 'plan' | 'users' | 'day:2026-11-11' (a missing day returns an empty day). */
    public function get(string $doc): array;

    public function put(string $doc, array $data): void;
}
