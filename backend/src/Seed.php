<?php
// First-start content (§4.2, R3, R16, R33) and the holiday seed file reader.
final class Seed
{
    public const WASTE_TYPES = [
        ['code' => 'REL', 'name' => 'REL', 'abbr' => 'REL', 'unit' => 'kg', 'weigh_method' => 'on_site',
            'routable' => true, 'confirm_over' => 1000, 'active' => true],
        ['code' => 'RECYCLING', 'name' => 'Recycling', 'abbr' => 'RCY', 'unit' => 'kg', 'weigh_method' => 'on_site',
            'routable' => true, 'confirm_over' => 1000, 'active' => true],
        ['code' => 'OTC', 'name' => 'OTC', 'abbr' => 'OTC', 'unit' => 'kg', 'weigh_method' => 'on_site',
            'routable' => false, 'confirm_over' => 1000, 'active' => true],
        ['code' => 'COMPACTOR', 'name' => 'COMPACTOR', 'abbr' => 'COMPACTOR', 'unit' => 'kg', 'weigh_method' => 'on_site',
            'routable' => false, 'confirm_over' => null, 'active' => true],
        ['code' => 'EROSE', 'name' => 'EROSE', 'abbr' => 'EROSE', 'unit' => 'kg', 'weigh_method' => 'on_site',
            'routable' => false, 'confirm_over' => null, 'active' => true],
    ];

    public const DEFAULT_ROLLOVER_HOUR = 4;

    /**
     * Reads backend/seed/holidays-sg.json: {"2026":[{date,name}…], "2027":[…]}.
     * @return array<int, list<array{date:string,name:string}>> year => holidays
     */
    public static function holidayYears(string $file): array
    {
        if (!is_file($file)) {
            return [];
        }
        $data = json_decode((string) file_get_contents($file), true);
        if (!is_array($data)) {
            throw new RuntimeException("Holiday seed file does not decode: $file");
        }
        $out = [];
        foreach ($data as $year => $list) {
            if (!is_array($list)) {
                continue;
            }
            $out[(int) $year] = array_values(array_filter($list, static fn ($h) => is_array($h)
                && Dates::valid($h['date'] ?? null) && is_string($h['name'] ?? null)));
        }
        ksort($out);
        return $out;
    }

    /** plan.json on first start: every seed year imported in full (R16). */
    public static function plan(string $today, string $seedFile): array
    {
        $years = self::holidayYears($seedFile);
        $holidays = [];
        foreach ($years as $list) {
            foreach ($list as $h) {
                $holidays[$h['date']] = ['date' => $h['date'], 'name' => $h['name']];
            }
        }
        ksort($holidays);
        return [
            'schema' => 1,
            'frozen_through' => Dates::addDays($today, -1),
            'seeded_years' => array_keys($years),
            'settings' => ['rollover_hour' => self::DEFAULT_ROLLOVER_HOUR],
            'seq' => ['customer' => 0, 'route' => 0],
            'waste_types' => self::WASTE_TYPES,
            'trucks' => [],
            'holidays' => array_values($holidays),
            'customers' => [],
            'routes' => [],
            'route_overrides' => [],
        ];
    }

    /** users.json on first start: the admin with a random password that must be changed (R33). */
    public static function users(string $adminPassword): array
    {
        return [
            'seq' => 1,
            'users' => [[
                'id' => 1, 'username' => 'admin', 'name' => 'Admin', 'role' => 'admin', 'lang' => 'zh',
                'password_hash' => password_hash($adminPassword, PASSWORD_DEFAULT),
                'must_change_password' => true, 'active' => true,
                'token_version' => 1, 'failed_logins' => [],
            ]],
        ];
    }

    /** 12 random characters without look-alikes (0/O, 1/l/I). */
    public static function randomPassword(int $length = 12): string
    {
        $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $out = '';
        for ($i = 0; $i < $length; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        return $out;
    }
}
