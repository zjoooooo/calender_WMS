<?php
// php backend/tests/backup_test.php — runs tools/backup.php twice on a temp data dir with photos (§13).
$fail = [];
$ok = 0;
$check = static function (string $name, bool $cond) use (&$fail, &$ok): void {
    if ($cond) {
        $ok++;
        echo "  ok    $name\n";
    } else {
        $fail[] = $name;
        echo "  FAIL  $name\n";
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
    } elseif (file_exists($p)) {
        unlink($p);
    }
};
$base = sys_get_temp_dir() . '/wms-backup-test-' . getmypid();
$data = "$base/data";
$dest = "$base/backups";
$rmrf($base);
$u1 = '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1';
$u2 = '5d2a1c2a-7f3d-4c55-9a1e-2b9d6a0c31f2';
@mkdir("$data/days", 0777, true);
@mkdir("$data/audit", 0777, true);
@mkdir("$data/files/0b", 0777, true);
@mkdir("$data/files/5d", 0777, true);
file_put_contents("$data/plan.json", '{"schema":1}');
file_put_contents("$data/plan.json.bak", '{"schema":1}');
file_put_contents("$data/users.json", '{"seq":0,"users":[]}');
file_put_contents("$data/secret.key", str_repeat('ab', 32));
file_put_contents("$data/days/2026-11-11.json", '{"date":"2026-11-11"}');
file_put_contents("$data/audit/2026-11.jsonl", "{}\n");
file_put_contents("$data/files/0b/$u1.jpg", "\xFF\xD8\xFFphoto1");
file_put_contents("$data/.lock", '');
file_put_contents("$data/.plan.json.abcd.tmp", 'partial');

$run = static function (array $extra = []) use ($data, $dest): int {
    $cmd = [PHP_BINARY, __DIR__ . '/../tools/backup.php', $dest, ...$extra];
    $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge(getenv(), ['WMS_DATA_DIR' => $data]));
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    return proc_close($p);
};
$folders = static fn () => array_values(array_filter(scandir($dest) ?: [], static fn ($e) => preg_match('/^\d{4}-\d{2}-\d{2}_\d{6}$/', $e)));

// an old folder that --keep must delete, and a recent one it must keep
@mkdir($dest, 0777, true);
$old = date('Y-m-d', strtotime('-40 days')) . '_043000';
$recent = date('Y-m-d', strtotime('-3 days')) . '_043000';
mkdir("$dest/$old");
mkdir("$dest/$recent");

$check('first backup exits 0', $run(['--keep', '30', '--min-free', '0']) === 0);
$f = $folders();
$check('old folder pruned, recent kept', !in_array($old, $f, true) && in_array($recent, $f, true));
$first = end($f);
file_put_contents("$data/files/5d/$u2.png", "\x89PNGsig");
sleep(1); // a new dated folder name (seconds resolution)
$check('second backup exits 0', $run(['--min-free', '0']) === 0);
$f = $folders();
$second = end($f);
$check('two new dated folders', $first !== $second && count($f) === 3);
foreach (['plan.json', 'plan.json.bak', 'users.json', 'secret.key', 'days/2026-11-11.json', 'audit/2026-11.jsonl', "files/0b/$u1.jpg", "files/5d/$u2.png"] as $rel) {
    $check("second folder has $rel", is_file("$dest/$second/$rel") && file_get_contents("$dest/$second/$rel") === file_get_contents("$data/$rel"));
}
$check('.lock and temp files are not copied', !file_exists("$dest/$second/.lock") && !file_exists("$dest/$second/.plan.json.abcd.tmp"));
$check('an old photo is a hard link to the first folder', fileinode("$dest/$second/files/0b/$u1.jpg") === fileinode("$dest/$first/files/0b/$u1.jpg"));
$check('a new photo is a fresh copy', fileinode("$dest/$second/files/5d/$u2.png") !== fileinode("$data/files/5d/$u2.png")
    && stat("$dest/$second/files/5d/$u2.png")['nlink'] === 1);
$check('JSON is copied, not linked', fileinode("$dest/$second/plan.json") !== fileinode("$dest/$first/plan.json"));
$check('no .partial left', glob("$dest/.*.partial") === []);
// A .partial folder left by a killed run is removed after a day; a fresh one (a run in progress) is kept.
$stale = "$dest/.2001-01-01_043000.partial";
$fresh = "$dest/.2001-01-02_043000.partial";
mkdir("$stale/days", 0777, true);
mkdir($fresh);
touch($stale, time() - 2 * 86400);
sleep(1);
$check('third backup exits 0', $run(['--min-free', '0']) === 0);
$check('a stale .partial folder is removed', !file_exists($stale));
$check('a fresh .partial folder is kept', is_dir($fresh));
rmdir($fresh);
$check('under the free-space limit it exits non-zero', $run(['--min-free', '1.01']) === 1);
$check('usage error without a dir', (static function () {
    $p = proc_open([PHP_BINARY, __DIR__ . '/../tools/backup.php'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    return proc_close($p);
})() === 2);

$rmrf($base);
echo "\n$ok passed, " . count($fail) . " failed\n";
exit($fail ? 1 : 0);
