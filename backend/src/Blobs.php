<?php
// Photos and signatures (R35). Immutable files under data/files/<first 2 chars>/<uuid>.<ext>.
// Not part of the JSON transaction: callers write and stream them OUTSIDE the global lock.
final class Blobs
{
    public function __construct(private string $dataDir)
    {
        $this->dataDir = rtrim(str_replace('\\', '/', $dataDir), '/');
    }

    /** Parses '<uuid>.<jpg|png>' (lower-case UUID v4); null when invalid. @return array{0:string,1:string}|null */
    public static function parseName(string $name): ?array
    {
        if (!preg_match('/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png)$/', $name, $m)) {
            return null;
        }
        return [$m[1], $m[2]];
    }

    /** Relative path stored in visits: 'files/0b/<uuid>.jpg'. */
    public static function relPath(string $uuid, string $ext): string
    {
        return 'files/' . substr($uuid, 0, 2) . '/' . $uuid . '.' . $ext;
    }

    /** Stores the bytes (temp file + rename). Idempotent: an existing file is left unchanged. */
    public function put(string $uuid, string $ext, string $bytes): string
    {
        $rel = self::relPath($uuid, $ext);
        $file = $this->dataDir . '/' . $rel;
        if (!is_file($file)) {
            FileStore::atomicWrite($file, $bytes);
        }
        return $rel;
    }

    public function exists(string $path): bool
    {
        return $this->safe($path) !== null && is_file($this->dataDir . '/' . $path);
    }

    /** Sends the file bytes to the output (headers are the caller's job). */
    public function stream(string $path): void
    {
        if ($this->safe($path) === null) {
            throw new InvalidArgumentException('Bad file path');
        }
        readfile($this->dataDir . '/' . $path);
    }

    private function safe(string $path): ?string
    {
        return preg_match('#^files/[0-9a-f]{2}/[0-9a-f-]{36}\.(jpg|png)$#', $path) ? $path : null;
    }
}
