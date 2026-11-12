<?php
// Backend rule tests (§13): php backend/tests/run.php [name-filter]
//
// 1. tests/unit/*.php   each file returns ['test name' => function (): void { … }, …]
//                       (use T::eq/T::ok/T::err/T::subset and TestEnv from tests/lib.php)
// 2. tests/cases/*.json each file is a list of table-driven cases:
//    {"name", "now", "given": {plan, users, days, files, first_start, demo},
//     "call": {"method","path","body","as","ip","raw"},
//     "expect": {"status","code","data_subset","docs_subset":{"plan":{…},"day:2026-11-11":{…}},"warnings"}}
//    or "steps": [{"now"?, "call", "expect"}, …] for several calls on the same data dir.
//    Subset rules and operators ($absent, $contains, $len …): see T::mismatch in tests/lib.php.
// Exit code 0 when everything passes.

$config = require __DIR__ . '/../bootstrap.php';
require __DIR__ . '/lib.php';
$GLOBALS['WMS_TEST_CONFIG'] = $config;
ini_set('log_errors', '0'); // expected warnings (e.g. ignored fake_now) stay out of the output

$filter = $argv[1] ?? '';
$passed = 0;
$failed = [];

$runOne = static function (string $name, callable $fn) use (&$passed, &$failed, $filter): void {
    if ($filter !== '' && stripos($name, $filter) === false) {
        return;
    }
    try {
        $fn();
        $passed++;
        echo "  ok    $name\n";
    } catch (Throwable $e) {
        $where = $e instanceof TestFailure ? '' : ' (' . get_class($e) . ' at ' . basename($e->getFile()) . ':' . $e->getLine() . ')';
        $failed[] = $name;
        echo "  FAIL  $name\n        " . $e->getMessage() . $where . "\n";
    } finally {
        TestEnv::cleanupAll();
    }
};

$unitFiles = glob(__DIR__ . '/unit/*.php') ?: [];
sort($unitFiles);
foreach ($unitFiles as $file) {
    echo basename($file) . "\n";
    $tests = require $file;
    foreach ($tests as $name => $fn) {
        $runOne(basename($file, '.php') . ': ' . $name, $fn);
    }
}

$checkExpect = static function (TestEnv $env, array $res, array $expect, string $label): void {
    if (array_key_exists('status', $expect)) {
        T::eq($expect['status'], $res['status'], "$label status (" . T::show($res['json']) . ')');
    }
    if (array_key_exists('code', $expect)) {
        T::eq($expect['code'], $res['json']['error']['code'] ?? null, "$label error code");
    }
    if (array_key_exists('error_subset', $expect)) {
        T::subset($expect['error_subset'], $res['json']['error'] ?? null, "$label error");
    }
    if (array_key_exists('data_subset', $expect)) {
        T::subset($expect['data_subset'], $res['json']['data'] ?? null, "$label data");
    }
    if (array_key_exists('warnings', $expect)) {
        T::subset($expect['warnings'], $res['json']['warnings'] ?? null, "$label warnings");
    }
    foreach ($expect['docs_subset'] ?? [] as $doc => $want) {
        T::subset($want, $env->doc($doc), "$label doc $doc");
    }
};

$caseFiles = glob(__DIR__ . '/cases/*.json') ?: [];
sort($caseFiles);
foreach ($caseFiles as $file) {
    echo basename($file) . "\n";
    $cases = json_decode((string) file_get_contents($file), true);
    if (!is_array($cases)) {
        $failed[] = basename($file) . ' (does not decode)';
        echo "  FAIL  " . basename($file) . " does not decode\n";
        continue;
    }
    foreach ($cases as $i => $case) {
        $name = basename($file, '.json') . ': ' . ($case['name'] ?? "#$i");
        $runOne($name, static function () use ($case, $checkExpect): void {
            $env = TestEnv::make($case['now'], $case['given'] ?? []);
            try {
                $steps = $case['steps'] ?? [['call' => $case['call'], 'expect' => $case['expect'] ?? []]];
                foreach ($steps as $n => $step) {
                    if (isset($step['now'])) {
                        $env->setNow($step['now']);
                    }
                    $call = $step['call'];
                    $res = $env->call($call['method'] ?? 'GET', $call['path'], $call['body'] ?? null, $call['as'] ?? null,
                        array_filter(['ip' => $call['ip'] ?? null, 'raw' => $call['raw'] ?? null], static fn ($v) => $v !== null));
                    $checkExpect($env, $res, $step['expect'] ?? [], 'step ' . ($n + 1));
                }
            } finally {
                $env->cleanup();
            }
        });
    }
}

$total = $passed + count($failed);
echo "\n$passed/$total passed, " . T::$assertions . " assertions\n";
if ($failed) {
    echo "FAILED:\n  - " . implode("\n  - ", $failed) . "\n";
    exit(1);
}
exit(0);
