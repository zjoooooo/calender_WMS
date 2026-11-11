<?php
// R16: at the start of every request (after the R13 freeze, which runs at order 10), import every year
// of seed/holidays-sg.json that is not yet in plan.seeded_years. Only dates > today are added; dates on
// today or earlier are skipped and listed in the audit log.
Hooks::beforeRequest('holiday_seed_import', static function (Ctx $c): void {
    $years = Seed::holidayYears((string) $c->config('seed_file'));
    if ($years === []) {
        return;
    }
    $report = null;
    $plan = Holidays::importSeed($c->tx->get('plan'), $years, $c->today, $report);
    if ($plan === null) {
        return;
    }
    $c->tx->put('plan', $plan);
    $c->afterCommit(static function (Ctx $c) use ($report): void {
        $c->store()->audit(['at' => $c->nowIso, 'user_id' => null, 'username' => 'system', 'method' => 'SEED',
            'path' => 'seed/holidays-sg.json', 'status' => 200, 'body' => $report]);
    });
}, 20);
