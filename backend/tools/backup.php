<?php
// Backup of the whole data dir (§11.2, §11.4):
//   php backend/tools/backup.php <dir> [--keep 30] [--min-free 0.15]
// - Writes a dated folder <dir>/YYYY-MM-DD_HHMMSS (config.tz) with everything except .lock and temp
//   files: plan, users, days/, secret.key, audit/, *.bak, files/ …
// - Everything except files/ is copied under the same flock as the server (one consistent moment).
//   files/ (immutable photos) is done outside the lock: a photo already in the newest earlier dated
//   folder is hard-linked from there (stored once on disk); only new photos are copied.
// - The folder is written as .<name>.partial and renamed when complete. A failed run deletes its
//   .partial folder; one left by a killed run (power cut) is deleted by the next run after a day.
// - Deletes dated folders older than --keep days.
// - Exits non-zero with a log line when the backup disk has under 15% free (after backing up).
$config = require __DIR__ . '/../bootstrap.php';

$args = $argv;
array_shift($args);
$dest = null;
$keep = 30;
$minFree = 0.15;
for ($i = 0; $i < count($args); $i++) {
    if ($args[$i] === '--keep') {
        $keep = (int) ($args[++$i] ?? 30);
    } elseif ($args[$i] === '--min-free') {
        $minFree = (float) ($args[++$i] ?? 0.15);
    } elseif ($dest === null) {
        $dest = rtrim(str_replace('\\', '/', $args[$i]), '/');
    }
}
if ($dest === null || $keep < 1) {
    fwrite(STDERR, "Usage: php backup.php <dir> [--keep 30] [--min-free 0.15]\n");
    exit(2);
}
/** One log line on stderr (the systemd journal); also to the PHP error_log file when one is configured. */
$logLine = static function (string $msg): void {
    fwrite(STDERR, $msg . "\n");
    if ((string) ini_get('error_log') !== '') {
        error_log($msg);
    }
};
$src = rtrim((string) $config['data_dir'], '/');
if (!is_file("$src/plan.json")) {
    $logLine("WMS backup failed: no data at $src");
    exit(1);
}

$isDated = static fn (string $n): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}_\d{6}$/', $n);
$skip = static fn (string $n): bool => $n === '.lock' || str_ends_with($n, '.tmp') || str_ends_with($n, '.partial');

/** Copies $from to $to recursively. With $prevRoot, a file already in $prevRoot (same size) is hard-linked from there. */
$copyTree = static function (string $from, string $to, ?string $prevRoot, string $rel = '') use (&$copyTree, $skip): void {
    FileStore::ensureDir($to);
    foreach (scandir($from) as $e) {
        if ($e === '.' || $e === '..' || $skip($e)) {
            continue;
        }
        $f = "$from/$e";
        $t = "$to/$e";
        $r = $rel === '' ? $e : "$rel/$e";
        if (is_dir($f)) {
            $copyTree($f, $t, $prevRoot, $r);
        } elseif ($prevRoot !== null && is_file("$prevRoot/$r") && filesize("$prevRoot/$r") === filesize($f) && @link("$prevRoot/$r", $t)) {
            // photo already in the previous backup: hard link, stored once
        } elseif (!copy($f, $t)) {
            throw new RuntimeException("Cannot copy $f");
        }
    }
};

$rmrf = static function (string $p) use (&$rmrf): void {
    if (is_dir($p) && !is_link($p)) {
        foreach (scandir($p) as $e) {
            if ($e !== '.' && $e !== '..') {
                $rmrf("$p/$e");
            }
        }
        rmdir($p);
    } else {
        unlink($p);
    }
};
$work = null;

try {
    FileStore::ensureDir($dest);
    foreach (glob("$dest/.*.partial", GLOB_ONLYDIR) ?: [] as $stale) {
        if (filemtime($stale) < time() - 86400) {
            $rmrf($stale);
            echo 'WMS backup removed an unfinished folder: ' . basename($stale) . "\n";
        }
    }
    $name = date('Y-m-d_His');
    for ($n = 2; file_exists("$dest/$name"); $n++) {
        $name = date('Y-m-d_His', time() + $n - 1);
    }
    $dated = array_values(array_filter(scandir($dest), static fn ($e) => $isDated($e) && is_dir("$dest/$e")));
    sort($dated);
    $prev = $dated === [] ? null : "$dest/" . end($dated);
    $work = "$dest/.$name.partial";

    $store = new FileStore($config);
    $store->lock(static function () use ($src, $work, $copyTree, $skip): void {
        FileStore::ensureDir($work);
        foreach (scandir($src) as $e) {
            if ($e === '.' || $e === '..' || $e === 'files' || $skip($e)) {
                continue;
            }
            if (is_dir("$src/$e")) {
                $copyTree("$src/$e", "$work/$e", null);
            } elseif (!copy("$src/$e", "$work/$e")) {
                throw new RuntimeException("Cannot copy $src/$e");
            }
        }
    });
    if (is_dir("$src/files")) {
        $copyTree("$src/files", "$work/files", $prev === null ? null : "$prev/files");
    }
    if (!rename($work, "$dest/$name")) {
        throw new RuntimeException("Cannot rename $work");
    }
    $work = null;
    echo "WMS backup written: $dest/$name\n";

    // Prune dated folders older than --keep days.
    $limit = date('Y-m-d', strtotime("-$keep days"));
    foreach (scandir($dest) as $e) {
        if ($isDated($e) && substr($e, 0, 10) < $limit) {
            $rmrf("$dest/$e");
            echo "WMS backup pruned: $e\n";
        }
    }

    $free = @disk_free_space($dest);
    $total = @disk_total_space($dest);
    if ($free !== false && $total !== false && $total > 0 && $free / $total < $minFree) {
        $pct = round(100 * $free / $total, 1);
        $logLine("WMS backup: only $pct% free on the backup disk ($dest); free some space or resize the disk");
        exit(1);
    }
    exit(0);
} catch (Throwable $e) {
    if ($work !== null && is_dir($work)) {
        try {
            $rmrf($work); // never leave a half-written folder behind
        } catch (Throwable) {
        }
    }
    $logLine('WMS backup failed: ' . $e->getMessage());
    exit(1);
}
