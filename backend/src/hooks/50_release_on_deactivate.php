<?php
// R24: deactivating a driver releases every job that driver holds today (end = released).
// Minimal default; the Runs part may replace it by adding a hook with the same name.
Hooks::add(Hooks::USER_DEACTIVATED, 'release_jobs', static function (Ctx $c, array $user): void {
    $doc = 'day:' . $c->today;
    $day = $c->tx->get($doc);
    $held = Users::heldJobs($c->tx->get('plan'), $day, $user['id']);
    foreach ($held as $h) {
        $run = $day['runs'][$h['job']];
        $run['driver_id'] = null;
        foreach ($run['holds'] ?? [] as $k => $hold) {
            if (($hold['to'] ?? null) === null) {
                $run['holds'][$k]['to'] = $c->nowIso;
                $run['holds'][$k]['end'] = 'released';
            }
        }
        $day['runs'][$h['job']] = $run;
    }
    if ($held !== []) {
        $c->tx->put($doc, $day);
    }
});
