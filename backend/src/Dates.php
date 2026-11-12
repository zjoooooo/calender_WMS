<?php
// Calendar-date helpers on 'YYYY-MM-DD' strings (no clock, no time zone: pure date arithmetic in UTC).
// R2 day class lives here too, so every part of the backend uses the same rule.
final class Dates
{
    /** A real calendar date in YYYY-MM-DD form. */
    public static function valid(mixed $d): bool
    {
        if (!is_string($d) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) {
            return false;
        }
        return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    private static function ts(string $d): int
    {
        [$y, $m, $day] = array_map('intval', explode('-', $d));
        return gmmktime(12, 0, 0, $m, $day, $y);
    }

    public static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', self::ts($d) + $n * 86400);
    }

    /** ISO weekday: 1 = Monday ... 7 = Sunday. */
    public static function weekday(string $d): int
    {
        return (int) gmdate('N', self::ts($d));
    }

    /** Whole days from $a to $b ($b - $a). */
    public static function diff(string $a, string $b): int
    {
        return intdiv(self::ts($b) - self::ts($a), 86400);
    }

    public static function year(string $d): int
    {
        return (int) substr($d, 0, 4);
    }

    /** @return array<string,string> date => holiday name */
    public static function holidayMap(array $plan): array
    {
        $map = [];
        foreach ($plan['holidays'] ?? [] as $h) {
            $map[$h['date']] = $h['name'];
        }
        return $map;
    }

    /**
     * R2: 'rest' if the date is a Sunday or a public holiday, otherwise 'work'.
     * @param array<string,mixed> $holidays date => anything (e.g. Dates::holidayMap($plan))
     */
    public static function dayClass(string $d, array $holidays): string
    {
        return (self::weekday($d) === 7 || isset($holidays[$d])) ? 'rest' : 'work';
    }

    /** The first work day after $d (R2). */
    public static function nextWorkDay(string $d, array $holidays): string
    {
        $x = self::addDays($d, 1);
        for ($i = 0; $i < 400 && self::dayClass($x, $holidays) === 'rest'; $i++) {
            $x = self::addDays($x, 1);
        }
        return $x;
    }

    /** Short English label used in generated names: "Fri 25 Dec". */
    public static function label(string $d): string
    {
        return gmdate('D j M', self::ts($d));
    }
}
