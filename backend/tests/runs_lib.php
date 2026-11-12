<?php
// Shared setup for the runs / driver / visits / files tests (tests/unit/runs_*.php, visits_test.php, files_test.php).
// RunsFx::env() = the basic fixture (today Wed 2026-11-11) plus, for today:
//   r5  N1  regular Mon/Wed/Fri, stops 12 (ABC Restaurant, REL+OTC), 40 (Golden Bakery, REL+COMPACTOR)
//   r50 A2  adhoc, stops 21 (Sunday Market Stall, REL)
//   r51 A3  adhoc, no stops (never runnable)
//   plus tasks 6 (fixture), 11 and 12 of the old task feature: legacy data that nothing reads any more
// and users admin(1) mei(2, office) ali(3) bala(4) chong(5) drivers, dan(6) an inactive driver.
// Unless 'runs' / 'days' are given, today's day file is EMPTY (the fixture's runs are not used).

final class RunsFx
{
    public const NOW = '2026-11-11T10:00:00+08:00';
    public const WED = '2026-11-11';

    /** @param array $o runs (today's runs by job), days, plan (top-level keys replace), given (extra TestEnv keys) */
    public static function env(array $o = [], ?string $now = null): TestEnv
    {
        $fx = json_decode((string) file_get_contents(__DIR__ . '/fixtures/basic.json'), true);
        $plan = $fx['plan'];
        $plan['seq'] = ['customer' => 70, 'route' => 51, 'task' => 12];
        $plan['routes'][] = ['id' => 50, 'code' => 'A2', 'color' => 2, 'type' => 'adhoc', 'name' => 'Adhoc today', 'note' => 'urgent',
            'rev' => 1, 'date' => self::WED, 'copied_from' => null, 'stops' => [['customer_id' => 21, 'note' => 'gate B']]];
        $plan['routes'][] = ['id' => 51, 'code' => 'A3', 'color' => 3, 'type' => 'adhoc', 'name' => 'Empty adhoc', 'note' => '',
            'rev' => 1, 'date' => self::WED, 'copied_from' => null, 'stops' => []];
        $plan['tasks'][] = ['id' => 11, 'waste_type' => 'OTC', 'customer_id' => 50, 'note' => 'Sofa', 'rev' => 1, 'date' => self::WED, 'copied_from' => null];
        $plan['tasks'][] = ['id' => 12, 'waste_type' => 'COMPACTOR', 'customer_id' => 40, 'note' => '', 'rev' => 1, 'date' => self::WED, 'copied_from' => null];
        $plan = array_replace($plan, $o['plan'] ?? []);
        $days = $o['days'] ?? [self::WED => self::day(self::WED, $o['runs'] ?? [])];
        $users = array_merge(TestEnv::defaultUsers(), [
            TestEnv::user(5, 'chong', 'driver'),
            TestEnv::user(6, 'dan', 'driver', ['active' => false]),
        ]);
        return TestEnv::make($now ?? self::NOW, array_replace(['plan' => $plan, 'days' => $days, 'users' => $users], $o['given'] ?? []));
    }

    public static function day(string $date, array $runs): array
    {
        return ['date' => $date, 'plan' => null, 'runs' => (object) $runs, 'dropped_runs' => []];
    }

    public static function hold(int $driver, string $from = '2026-11-11T07:30:00+08:00', ?string $plate = 'SBA1234X', ?string $to = null, ?string $end = null): array
    {
        return ['driver_id' => $driver, 'vehicle_no' => $plate, 'by' => 'self', 'from' => $from, 'to' => $to, 'end' => $end];
    }

    /** A run; $holder null = no holder (pass closed holds yourself). */
    public static function run(string $job, ?int $holder, array $visits = [], ?array $holds = null, array $removed = []): array
    {
        $holds ??= $holder === null ? [] : [self::hold($holder)];
        $vs = [];
        foreach ($visits as $v) {
            $vs[(string) $v['customer_id']] = $v;
        }
        return ['job' => $job, 'driver_id' => $holder, 'holds' => $holds, 'removed' => $removed, 'visits' => (object) $vs];
    }

    /** A stored visit as the server writes it. */
    public static function visit(int $cid, string $outcome = 'collected', array $weights = ['REL' => 10.0], string $by = 'user:3', int $rev = 1, ?int $driver = 3, array $extra = []): array
    {
        return array_merge([
            'customer_id' => $cid, 'outcome' => $outcome, 'weights' => $outcome === 'collected' ? $weights : [], 'tickets' => [],
            'photos' => [], 'signature' => null, 'reason' => $outcome === 'missed' ? 'closed' : null, 'note' => '', 'why' => null,
            'driver_id' => $driver, 'by' => $by, 'customer' => ['code' => 'C' . $cid, 'name' => 'Customer ' . $cid, 'address' => ''],
            'captured_at' => '2026-11-11T09:00:00+08:00', 'received_at' => '2026-11-11T09:00:05+08:00',
            'rev' => $rev, 'flags' => [], 'op_id' => self::op(900 + $cid), 'ops' => [['op_id' => self::op(900 + $cid), 'result' => 'applied']], 'history' => [],
        ], $extra);
    }

    /** A deterministic UUID v4 for op ids and file names. */
    public static function op(int $n): string
    {
        return sprintf('00000000-0000-4000-8000-%012d', $n);
    }

    /** A result-write body. */
    public static function body(int $op, int $baseRev, ?string $outcome = 'collected', array $extra = []): array
    {
        $b = ['op_id' => self::op($op), 'base_rev' => $baseRev, 'outcome' => $outcome];
        if ($outcome === 'collected') {
            $b += ['weights' => ['REL' => 50.0], 'tickets' => (object) [], 'photos' => [], 'signature' => null, 'reason' => null, 'note' => ''];
        } elseif ($outcome === 'missed') {
            $b += ['weights' => (object) [], 'tickets' => (object) [], 'photos' => [], 'signature' => null, 'reason' => 'closed', 'note' => ''];
        }
        return array_replace($b, $extra);
    }

    public static function claim(TestEnv $e, string $job, string $as, array $body = ['vehicle_no' => 'SBA1234X'], string $date = self::WED): array
    {
        return $e->call('POST', "/api/driver/runs/$date/$job/claim", $body, $as);
    }

    public static function put(TestEnv $e, string $job, int $cid, array $body, string $as, string $date = self::WED, bool $office = false): array
    {
        $prefix = $office ? '/api/runs' : '/api/driver/runs';
        return $e->call('PUT', "$prefix/$date/$job/stops/$cid", $body, $as);
    }

    /** A free-submission body (Submissions::driverWrite): OTC 50 kg for customer 12 with plate SBA1234X. */
    public static function subBody(int $op, array $extra = []): array
    {
        return array_replace(['op_id' => self::op($op), 'base_rev' => 0, 'waste_type' => 'OTC', 'customer_id' => 12, 'vehicle_no' => 'SBA1234X',
            'outcome' => 'collected', 'weights' => ['OTC' => 50.0], 'tickets' => (object) [], 'photos' => [], 'signature' => null, 'note' => ''], $extra);
    }

    /** PUT /api/driver/submissions/{date}/{id}; the id is op($n). */
    public static function sub(TestEnv $e, int $n, array $body, string $as = 'ali', string $date = self::WED): array
    {
        return $e->call('PUT', "/api/driver/submissions/$date/" . self::op($n), $body, $as);
    }

    /** Today's run of a job from disk (null when absent). */
    public static function diskRun(TestEnv $e, string $job, string $date = self::WED): ?array
    {
        return $e->doc('day:' . $date)['runs'][$job] ?? null;
    }

    /** The calendar occurrence of key 'r5@2026-11-11' (office view). */
    public static function occ(TestEnv $e, string $key): ?array
    {
        [$job, $date] = explode('@', $key);
        $cal = T::ok($e->call('GET', '/api/calendar?view=week&anchor=' . $date, null, 'mei'));
        foreach ($cal['routes'] as $o) {
            if ($o['key'] === $key) {
                return $o;
            }
        }
        return null;
    }

    /** A fake JPEG / PNG body. */
    public static function jpeg(string $tail = 'photo'): string
    {
        return "\xFF\xD8\xFF\xE0" . $tail;
    }

    public static function png(string $tail = 'sig'): string
    {
        return "\x89PNG\r\n\x1A\n" . $tail;
    }

    public static function upload(TestEnv $e, string $name, string $bytes, string $as = 'ali'): array
    {
        return $e->call('PUT', '/api/files/' . $name, null, $as, ['raw' => $bytes]);
    }
}
