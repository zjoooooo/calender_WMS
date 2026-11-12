<?php
// R16: holiday seed import per seeded_years (before_request hook).
$seedFile = static function (): string {
    $f = sys_get_temp_dir() . '/wms-seed-' . getmypid() . '.json';
    file_put_contents($f, json_encode([
        '2026' => [['date' => '2026-12-25', 'name' => 'Christmas Day']],
        '2027' => [
            ['date' => '2027-01-01', 'name' => "New Year's Day"],
            ['date' => '2027-02-06', 'name' => 'Chinese New Year'],
            ['date' => '2027-05-01', 'name' => 'Labour Day'],
            ['date' => '2027-05-17', 'name' => 'Hari Raya Haji'],
            ['date' => '2027-12-25', 'name' => 'Christmas Day'],
        ],
    ]));
    return $f;
};
$given = static fn (string $file, array $plan = []) => [
    'config' => ['seed_file' => $file],
    'plan' => $plan + ['seeded_years' => [2026], 'holidays' => [['date' => '2026-12-25', 'name' => 'Christmas Day']]],
];

return [
    'a seed year added later is imported once, on the next request' => function () use ($seedFile, $given) {
        $f = $seedFile();
        $env = TestEnv::make('2026-11-11T10:00:00+08:00', $given($f));
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        $plan = $env->doc('plan');
        T::eq([2026, 2027], $plan['seeded_years']);
        T::eq(['2026-12-25', '2027-01-01', '2027-02-06', '2027-05-01', '2027-05-17', '2027-12-25'], array_column($plan['holidays'], 'date'));
        $audit = $env->doc('audit:2026-11');
        T::eq(1, count($audit));
        T::subset(['username' => 'system', 'method' => 'SEED', 'body' => ['2027' => ['imported' => ['$len' => 5], 'skipped' => []]]], $audit[0]);
        // a deleted holiday is never re-added
        T::eq(204, $env->call('DELETE', '/api/holidays/2027-05-01', null, 'mei')['status']);
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::ok($env->call('GET', '/api/holidays?year=2027', null, 'mei'));
        T::eq(['2026-12-25', '2027-01-01', '2027-02-06', '2027-05-17', '2027-12-25'], array_column($env->doc('plan')['holidays'], 'date'));
        T::eq(2, count($env->doc('audit:2026-11')), 'only the DELETE added a line');
        $env->cleanup();
        unlink($f);
    },
    'a late import adds only dates after today and keeps existing names' => function () use ($seedFile, $given) {
        $f = $seedFile();
        $env = TestEnv::make('2027-02-06T10:00:00+08:00', $given($f, [
            'holidays' => [['date' => '2026-12-25', 'name' => 'Christmas Day'], ['date' => '2027-12-25', 'name' => 'Xmas (ours)']],
        ]));
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        $plan = $env->doc('plan');
        T::eq([
            ['date' => '2026-12-25', 'name' => 'Christmas Day'],
            ['date' => '2027-05-01', 'name' => 'Labour Day'],
            ['date' => '2027-05-17', 'name' => 'Hari Raya Haji'],
            ['date' => '2027-12-25', 'name' => 'Xmas (ours)'],
        ], $plan['holidays']);
        $audit = $env->doc('audit:2027-02');
        T::subset(['body' => ['2027' => [
            'imported' => ['2027-05-01', '2027-05-17'],
            'skipped' => [['2027-01-01', 'today or past'], ['2027-02-06', 'today or past'], ['2027-12-25', 'present']],
        ]]], $audit[0]);
        T::eq(false, file_exists($env->dir . '/days/2027-02-06.json'), 'no day file touched');
        $env->cleanup();
        unlink($f);
    },
    'a seed date under a stored adhoc or regular one-off is skipped' => function () use ($seedFile, $given) {
        $f = $seedFile();
        $env = TestEnv::make('2026-11-11T10:00:00+08:00', $given($f, [
            'routes' => [['id' => 1, 'code' => 'A1', 'color' => 1, 'type' => 'adhoc', 'name' => 'A', 'note' => '', 'rev' => 1,
                'date' => '2027-05-17', 'copied_from' => null, 'stops' => []]],
        ]));
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        $dates = array_column($env->doc('plan')['holidays'], 'date');
        T::true(!in_array('2027-05-17', $dates, true), 'skipped under the adhoc');
        T::true(in_array('2027-05-01', $dates, true));
        $env->cleanup();
        unlink($f);
    },
    'a failed request does not keep the import (it is redone by the next one)' => function () use ($seedFile, $given) {
        $f = $seedFile();
        $env = TestEnv::make('2026-11-11T10:00:00+08:00', $given($f));
        T::err($env->call('PUT', '/api/holidays/2026-01-05', ['name' => 'x'], 'mei'), 422, 'PAST_DATE_LOCKED');
        T::eq([2026], $env->doc('plan')['seeded_years']);
        T::eq([], $env->doc('audit:2026-11'));
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::eq([2026, 2027], $env->doc('plan')['seeded_years']);
        $env->cleanup();
        unlink($f);
    },
    'the real seed file has 2026 and 2027 with valid dates' => function () {
        $years = Seed::holidayYears($GLOBALS['WMS_TEST_CONFIG']['seed_file']);
        T::eq([2026, 2027], array_keys($years));
        T::eq(14, count($years[2026]));
        T::eq(12, count($years[2027]));
        foreach ($years as $y => $list) {
            $dates = array_column($list, 'date');
            $sorted = $dates;
            sort($sorted);
            T::eq($sorted, $dates, "$y sorted");
            foreach ($dates as $d) {
                T::eq($y, Dates::year($d), "$d in $y");
            }
        }
        T::eq('2027-02-08', $years[2027][3]['date']);
        T::eq('Chinese New Year (observed)', $years[2027][3]['name']);
    },
];
