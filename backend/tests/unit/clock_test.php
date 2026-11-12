<?php
// R1 operational day, R2 day class, fake_now rules, "clock read once, after the lock".
$dt = static fn (string $s) => new DateTimeImmutable($s);

return [
    'opDate around the 04:00 rollover' => function () use ($dt) {
        T::eq('2026-11-11', Clock::opDate($dt('2026-11-12T03:59:59+08:00'), 4));
        T::eq('2026-11-12', Clock::opDate($dt('2026-11-12T04:00:00+08:00'), 4));
        T::eq('2026-11-11', Clock::opDate($dt('2026-11-12T00:00:00+08:00'), 4));
        T::eq('2026-11-11', Clock::opDate($dt('2026-11-11T04:00:00+08:00'), 4));
        T::eq('2026-11-10', Clock::opDate($dt('2026-11-11T03:00:00+08:00'), 4));
    },
    'opDate with rollover 0 is plain midnight' => function () use ($dt) {
        T::eq('2026-11-12', Clock::opDate($dt('2026-11-12T00:00:00+08:00'), 0));
        T::eq('2026-11-11', Clock::opDate($dt('2026-11-11T23:59:59+08:00'), 0));
    },
    'opDate converts other offsets to Singapore time' => function () use ($dt) {
        // 19:59:59Z = 03:59:59 +08:00 on the 12th
        T::eq('2026-11-11', Clock::opDate($dt('2026-11-11T19:59:59Z'), 4));
        T::eq('2026-11-12', Clock::opDate($dt('2026-11-11T20:00:00Z'), 4));
    },
    'day start, day end and edit deadline' => function () {
        T::eq('2026-11-11T04:00:00+08:00', Clock::iso(Clock::dayStart('2026-11-11', 4)));
        T::eq('2026-11-12T04:00:00+08:00', Clock::iso(Clock::dayEnd('2026-11-11', 4)));
        T::eq('2026-11-12T12:00:00+08:00', Clock::iso(Clock::editDeadline('2026-11-11', 4, 8)));
        T::eq('2026-11-12T10:00:00+08:00', Clock::iso(Clock::editDeadline('2026-11-11', 2, 8)));
        T::eq('2027-01-01T04:00:00+08:00', Clock::iso(Clock::dayEnd('2026-12-31', 4)));
    },
    'Clock::parse accepts ISO timestamps only' => function () {
        T::eq('2026-11-12T03:50:00+08:00', Clock::iso(Clock::parse('2026-11-12T03:50:00+08:00')));
        T::eq(null, Clock::parse('12 Nov 2026'));
        T::eq(null, Clock::parse(null));
    },
    'Dates helpers' => function () {
        T::eq(3, Dates::weekday('2026-11-11'));
        T::eq(7, Dates::weekday('2026-11-15'));
        T::eq('2026-12-01', Dates::addDays('2026-11-30', 1));
        T::eq('2026-02-28', Dates::addDays('2026-03-01', -1));
        T::eq(7, Dates::diff('2026-11-11', '2026-11-18'));
        T::true(Dates::valid('2028-02-29'));
        T::true(!Dates::valid('2026-02-29'), '2026-02-29 is not a date');
        T::true(!Dates::valid('2026-1-01'), 'no short months');
        T::eq('Fri 25 Dec', Dates::label('2026-12-25'));
    },
    'R2 day class: Sunday and PH are rest' => function () {
        $plan = Seed::plan('2026-11-11', $GLOBALS['WMS_TEST_CONFIG']['seed_file']);
        $h = Dates::holidayMap($plan);
        T::eq('work', Dates::dayClass('2026-11-11', $h), 'Wed');
        T::eq('rest', Dates::dayClass('2026-11-15', $h), 'Sun');
        T::eq('rest', Dates::dayClass('2026-11-09', $h), 'Mon Deepavali (observed)');
        T::eq('rest', Dates::dayClass('2026-11-08', $h), 'Sun + PH');
        T::eq('rest', Dates::dayClass('2026-12-25', $h), 'Fri Christmas');
        T::eq('work', Dates::dayClass('2026-12-26', $h), 'Sat');
        T::eq('work', Dates::dayClass('2026-12-25', []), 'no holidays');
    },
    'next work day skips Sundays and PH' => function () {
        $h = Dates::holidayMap(Seed::plan('2026-11-01', $GLOBALS['WMS_TEST_CONFIG']['seed_file']));
        T::eq('2026-11-12', Dates::nextWorkDay('2026-11-11', $h));
        T::eq('2026-11-10', Dates::nextWorkDay('2026-11-07', $h)); // Sun 8 PH, Mon 9 PH
        T::eq('2026-12-26', Dates::nextWorkDay('2026-12-24', $h)); // Fri 25 Christmas
    },
    'fake_now is ignored without a .demo marker' => function () {
        $dir = sys_get_temp_dir() . '/wms-clock-' . getmypid();
        TestEnv::rmrf($dir);
        mkdir($dir);
        $cfg = ['tz' => 'Asia/Singapore', 'data_dir' => $dir, 'fake_now' => '2001-02-03T04:05:06+08:00'];
        $oldLog = ini_set('error_log', '/dev/null'); // the expected warning
        T::true((new Clock($cfg))->now()->format('Y') !== '2001', 'fake_now must be ignored');
        ini_set('error_log', (string) $oldLog);
        T::true(!(new Clock($cfg))->isFake());
        touch("$dir/.demo");
        T::eq('2001-02-03T04:05:06+08:00', (new Clock($cfg))->nowIso());
        T::true((new Clock($cfg))->isFake());
        TestEnv::rmrf($dir);
    },
    'now is memoised: read once per request' => function () {
        $clock = new Clock(['tz' => 'Asia/Singapore', 'data_dir' => '/nonexistent', 'fake_now' => null]);
        $reads = 0;
        $clock->onFirstRead = function () use (&$reads) {
            $reads++;
        };
        $a = $clock->now();
        usleep(1000);
        $b = $clock->now();
        T::eq(1, $reads);
        T::true($a === $b, 'same instance');
    },
    'the clock is first read while the lock is held' => function () {
        $env = TestEnv::make('2026-11-11T10:00:00+08:00');
        $locked = [];
        $env->app->onClockRead = function () use ($env, &$locked) {
            $locked[] = $env->app->store->isLocked();
        };
        T::ok($env->call('GET', '/api/meta', null, 'mei'));
        T::ok($env->call('POST', '/api/login', ['username' => 'ali', 'password' => TestEnv::PASSWORD]));
        T::eq([true, true], $locked);
        $env->cleanup();
    },
    'first-start seed reads the clock under the lock too' => function () {
        $env = TestEnv::make('2026-11-11T10:00:00+08:00', ['first_start' => true]);
        $env->app->store->onSeed = static function (): void {
        };
        $locked = [];
        $env->app->onClockRead = function () use ($env, &$locked) {
            $locked[] = $env->app->store->isLocked();
        };
        T::err($env->call('POST', '/api/login', ['username' => 'admin', 'password' => 'x']), 401, 'BAD_CREDENTIALS');
        T::eq([true], $locked);
        $env->cleanup();
    },
];
