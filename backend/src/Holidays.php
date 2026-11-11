<?php
// Public holidays (R16, §6.10, §10.7): one entry per date, sorted by date; add, rename and delete only
// for dates >= today; HOLIDAY_CONFLICT protects stored one-off routes. The yearly seed import runs as a
// before_request hook (src/hooks/holiday_seed.php -> Holidays::importSeed).
final class Holidays
{
    /** GET /api/holidays?year=2026 -> [{date, name, past}] */
    public static function list(Ctx $c): array
    {
        $year = $c->query('year');
        if ($year !== null && $year !== '' && !preg_match('/^\d{4}$/', $year)) {
            V::fail('year', 'Expected a year like 2026');
        }
        $out = [];
        foreach ($c->plan()['holidays'] ?? [] as $h) {
            if ($year === null || $year === '' || str_starts_with($h['date'], $year . '-')) {
                $out[] = ['date' => $h['date'], 'name' => $h['name'], 'past' => $h['date'] < $c->today];
            }
        }
        return $out;
    }

    /** PUT /api/holidays/{date} {"name", "release_run"?} -> upsert (201 when added, 200 when renamed). */
    public static function put(Ctx $c): array
    {
        $date = $c->dateParam('date');
        V::only($c->body, ['name', 'release_run']);
        $name = V::str($c->body['name'] ?? null, 'name', 1, 60);
        $releaseRun = array_key_exists('release_run', $c->body) && V::bool($c->body['release_run'], 'release_run');
        if ($date < $c->today) {
            throw new ApiError('PAST_DATE_LOCKED', 422, 'date');
        }
        $plan = $c->plan();
        $map = Dates::holidayMap($plan);
        $added = !isset($map[$date]);
        if ($added) {
            // A new holiday makes an adhoc or a regular one-off on that date illegal (R6).
            $conflicts = self::oneOffsOn($plan, $date, ['adhoc', 'regular']);
            if ($conflicts !== []) {
                throw new ApiError('HOLIDAY_CONFLICT', 409, 'date', ['routes' => $conflicts]);
            }
        }
        $map[$date] = $name;
        $plan['holidays'] = self::fromMap($map);
        $c->savePlan($plan, ['release_run' => $releaseRun]);
        $out = ['date' => $date, 'name' => $name, 'past' => false];
        return $added ? $c->created($out) : $out;
    }

    /** DELETE /api/holidays/{date}[?release_run=1] -> 204 */
    public static function delete(Ctx $c): mixed
    {
        $date = $c->dateParam('date');
        $plan = $c->plan();
        $map = Dates::holidayMap($plan);
        if (!isset($map[$date])) {
            throw new ApiError('NOT_FOUND', 404, 'date', null, 'No holiday on this date');
        }
        if ($date < $c->today) {
            throw new ApiError('PAST_DATE_LOCKED', 422, 'date');
        }
        if (Dates::weekday($date) !== 7) {
            // Without the holiday a non-Sunday becomes a work day: a special one-off there is illegal (R6).
            $conflicts = self::oneOffsOn($plan, $date, ['special']);
            if ($conflicts !== []) {
                throw new ApiError('HOLIDAY_CONFLICT', 409, 'date', ['routes' => $conflicts]);
            }
        }
        unset($map[$date]);
        $plan['holidays'] = self::fromMap($map);
        $c->savePlan($plan, ['release_run' => $c->queryBool('release_run')]);
        return $c->noContent();
    }

    /** @return list<array{id:int,code:string,name:string,type:string,date:string}> */
    public static function oneOffsOn(array $plan, string $date, array $types): array
    {
        $out = [];
        foreach ($plan['routes'] ?? [] as $r) {
            if (Usage::isOneOff($r) && $r['date'] === $date && in_array($r['type'], $types, true)) {
                $out[] = ['id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '', 'type' => $r['type'], 'date' => $r['date']];
            }
        }
        return $out;
    }

    /** @param array<string,string> $map */
    public static function fromMap(array $map): array
    {
        ksort($map);
        $out = [];
        foreach ($map as $date => $name) {
            $out[] = ['date' => (string) $date, 'name' => $name];
        }
        return $out;
    }

    /**
     * R16 later import: every year in the seed file that is not in plan.seeded_years is imported,
     * adding only dates > today that are not already present and not under a stored adhoc or regular
     * one-off; the year is then added to seeded_years. Returns the new plan, or null when nothing to do.
     * Skipped dates are reported through $report: [year => ['imported'=>[], 'skipped'=>[[date, reason]]]].
     */
    public static function importSeed(array $plan, array $seedYears, string $today, ?array &$report = null): ?array
    {
        $seeded = array_map('intval', $plan['seeded_years'] ?? []);
        $todo = array_diff(array_keys($seedYears), $seeded);
        if ($todo === []) {
            return null;
        }
        $report = [];
        $map = Dates::holidayMap($plan);
        foreach ($todo as $year) {
            $report[$year] = ['imported' => [], 'skipped' => []];
            foreach ($seedYears[$year] as $h) {
                $d = $h['date'];
                if (isset($map[$d])) {
                    $report[$year]['skipped'][] = [$d, 'present'];
                } elseif ($d <= $today) {
                    $report[$year]['skipped'][] = [$d, 'today or past'];
                } elseif (self::oneOffsOn($plan, $d, ['adhoc', 'regular']) !== []) {
                    $report[$year]['skipped'][] = [$d, 'one-off route'];
                } else {
                    $map[$d] = $h['name'];
                    $report[$year]['imported'][] = $d;
                }
            }
            $seeded[] = (int) $year;
        }
        sort($seeded);
        $plan['holidays'] = self::fromMap($map);
        $plan['seeded_years'] = array_values(array_unique($seeded));
        return $plan;
    }
}
