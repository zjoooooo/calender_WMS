<?php
// GET /api/meta (§10.3) and GET /api/health.
final class Meta
{
    public static function get(Ctx $c): array
    {
        $plan = $c->plan();
        $u = $c->user;
        return [
            'today' => $c->today,
            'now' => $c->nowIso,
            'timezone' => $c->config('tz'),
            'next_work_day' => Dates::nextWorkDay($c->today, Dates::holidayMap($plan)),
            'rollover_hour' => $c->rollover,
            'day_ends_at' => Clock::iso(Clock::dayEnd($c->today, $c->rollover)),
            'me' => ['id' => $u['id'], 'username' => $u['username'], 'name' => $u['name'], 'role' => $u['role'], 'lang' => $u['lang']],
            'waste_types' => $plan['waste_types'] ?? [],
            'trucks' => Settings::activePlates($plan),
            'config' => [
                'max_photos' => (int) $c->config('max_photos'),
                'driver_edit_grace_hours' => (int) $c->config('driver_edit_grace_hours'),
            ],
        ];
    }

    public static function health(Ctx $c): array
    {
        return ['ok' => true];
    }
}
