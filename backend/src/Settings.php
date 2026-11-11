<?php
// Settings page (§9.2, §10.7): trucks (the vehicle list drivers pick from, R23) and the day rollover
// hour (R1, admin only).
final class Settings
{
    /** Upper case, no spaces (R23). */
    public static function normalizePlate(string $plate): string
    {
        return strtoupper(preg_replace('/\s+/', '', $plate));
    }

    /** @return list<string> active plates */
    public static function activePlates(array $plan): array
    {
        $out = [];
        foreach ($plan['trucks'] ?? [] as $t) {
            if (!empty($t['active'])) {
                $out[] = $t['plate'];
            }
        }
        return $out;
    }

    /** GET /api/trucks -> [{plate, active}] */
    public static function trucks(Ctx $c): array
    {
        return array_map(static fn ($t) => ['plate' => $t['plate'], 'active' => (bool) $t['active']], $c->plan()['trucks'] ?? []);
    }

    /** PUT /api/trucks {"trucks":[{"plate","active"}]} -> the stored list (replaces the whole list). */
    public static function putTrucks(Ctx $c): array
    {
        V::only($c->body, ['trucks']);
        $list = V::list($c->body['trucks'] ?? null, 'trucks');
        $out = [];
        $seen = [];
        foreach ($list as $n => $t) {
            if (!is_array($t)) {
                V::fail("trucks.$n", 'Each truck must be {plate, active}');
            }
            V::only($t, ['plate', 'active']);
            $plate = self::normalizePlate(V::str($t['plate'] ?? null, "trucks.$n.plate", 1, 20));
            if (!preg_match('/^[A-Z0-9-]{1,15}$/', $plate)) {
                V::fail("trucks.$n.plate", 'A plate is 1-15 letters, digits or "-"');
            }
            if (isset($seen[$plate])) {
                V::fail("trucks.$n.plate", "Plate $plate is listed twice");
            }
            $seen[$plate] = true;
            $out[] = ['plate' => $plate, 'active' => V::bool($t['active'] ?? true, "trucks.$n.active")];
        }
        $plan = $c->plan();
        $plan['trucks'] = $out;
        $c->savePlan($plan);
        return $out;
    }

    /** GET /api/settings -> {"rollover_hour"} */
    public static function get(Ctx $c): array
    {
        return ['rollover_hour' => (int) ($c->plan()['settings']['rollover_hour'] ?? Seed::DEFAULT_ROLLOVER_HOUR)];
    }

    /**
     * PATCH /api/settings {"rollover_hour"} (admin). R1: refused with ROLLOVER_SHIFTS_TODAY when the
     * change would move the current op_date (forward or back); retry_after = max(old,new):00 today.
     */
    public static function patch(Ctx $c): array
    {
        V::only($c->body, ['rollover_hour']);
        $plan = $c->plan();
        $old = (int) ($plan['settings']['rollover_hour'] ?? Seed::DEFAULT_ROLLOVER_HOUR);
        if (array_key_exists('rollover_hour', $c->body)) {
            $new = V::int($c->body['rollover_hour'], 'rollover_hour', 0, 6);
            $today = Clock::opDate($c->now, $old);
            $wouldBe = Clock::opDate($c->now, $new);
            if ($today !== $wouldBe) {
                $calendarDate = $c->now->format('Y-m-d');
                throw new ApiError('ROLLOVER_SHIFTS_TODAY', 422, 'rollover_hour', [
                    'today' => $today,
                    'would_be' => $wouldBe,
                    'retry_after' => Clock::iso(Clock::dayStart($calendarDate, max($old, $new))),
                ]);
            }
            $plan['settings']['rollover_hour'] = $new;
            $c->savePlan($plan);
            return ['rollover_hour' => $new];
        }
        return ['rollover_hour' => $old];
    }
}
