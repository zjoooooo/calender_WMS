<?php
// Photos and signatures (R35, §10.10). Both routes are 'raw' + 'unlocked' (src/routes/runs.php): the body
// is read before the lock, auth and the R13 freeze run in a short locked section, and these handlers then
// run OUTSIDE the lock ($c->tx is null), so a slow 4G upload or download never holds the global lock.
// Files are immutable, so this is safe; uploads are idempotent (an existing file is left unchanged).
final class Files
{
    /** PUT /api/files/{uuid}.{jpg|png} (raw body) -> 201 {path} | 200 {path} (already stored). */
    public static function put(Ctx $c): array
    {
        $p = Blobs::parseName($c->param('name'));
        if ($p === null) {
            throw new ApiError('FILE_INVALID', 422, 'name', null, 'The file name must be <uuid v4>.jpg or <uuid v4>.png');
        }
        [$uuid, $ext] = $p;
        $bytes = $c->req->body ?? '';
        $max = (int) $c->config($ext === 'jpg' ? 'max_jpeg_bytes' : 'max_png_bytes');
        if (strlen($bytes) > $max) {
            throw new ApiError('FILE_TOO_LARGE', 413, null, ['max_bytes' => $max]);
        }
        $magic = $ext === 'jpg' ? "\xFF\xD8\xFF" : "\x89\x50\x4E\x47";
        if (!str_starts_with($bytes, $magic)) {
            throw new ApiError('FILE_INVALID', 422, null, null, $ext === 'jpg' ? 'This is not a JPEG file' : 'This is not a PNG file');
        }
        $blobs = new Blobs($c->dataDir());
        $path = Blobs::relPath($uuid, $ext);
        if ($blobs->exists($path)) {
            return ['path' => $path];
        }
        $blobs->put($uuid, $ext, $bytes);
        return $c->created(['path' => $path]);
    }

    /** GET /api/files/{uuid}.{jpg|png} -> the bytes (any signed-in user; streamed outside the lock). */
    public static function get(Ctx $c): Response
    {
        $p = Blobs::parseName($c->param('name'));
        $blobs = new Blobs($c->dataDir());
        $path = $p === null ? null : Blobs::relPath($p[0], $p[1]);
        if ($path === null || !$blobs->exists($path)) {
            throw new ApiError('NOT_FOUND', 404, 'name', null, 'No such file');
        }
        $size = (int) filesize($c->dataDir() . '/' . $path);
        return new Response(200, [
            'Content-Type' => $p[1] === 'jpg' ? 'image/jpeg' : 'image/png',
            'Content-Length' => (string) $size,
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ], '', static function () use ($blobs, $path): void {
            $blobs->stream($path);
        });
    }
}
