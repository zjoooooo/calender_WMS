<?php
// Backend configuration (§11.2). Do not edit this tracked file on a server or for a demo:
// put overrides in the git-ignored backend/config.local.php (it returns an array), or set
// WMS_DATA_DIR in the environment. The day rollover hour is NOT here: it is an admin setting
// stored in plan.json (R1).
$config = [
    'tz' => 'Asia/Singapore',
    'data_dir' => __DIR__ . '/data',
    'token_days' => 30,
    'driver_edit_grace_hours' => 8,
    'max_photos' => 5,
    'max_jpeg_bytes' => 2000000,
    'max_png_bytes' => 300000,
    'max_json_bytes' => 1048576,
    // ISO 8601 timestamp, e.g. '2026-11-12T03:59:00+08:00'. Honoured ONLY when the data dir
    // contains a `.demo` marker file (R1); otherwise ignored with a warning in the PHP error log.
    'fake_now' => null,
    'seed_file' => __DIR__ . '/seed/holidays-sg.json',
    'app_dir' => __DIR__ . '/public/app',
];

if (is_file(__DIR__ . '/config.local.php')) {
    $local = require __DIR__ . '/config.local.php';
    if (is_array($local)) {
        $config = array_replace($config, $local);
    }
}

$envDataDir = getenv('WMS_DATA_DIR');
if (is_string($envDataDir) && $envDataDir !== '') {
    $config['data_dir'] = $envDataDir;
}
// Test-only override of fake_now (still needs the .demo marker in the data dir).
$envFakeNow = getenv('WMS_FAKE_NOW');
if (is_string($envFakeNow) && $envFakeNow !== '') {
    $config['fake_now'] = $envFakeNow;
}

$config['data_dir'] = rtrim(str_replace('\\', '/', (string) $config['data_dir']), '/');

return $config;
