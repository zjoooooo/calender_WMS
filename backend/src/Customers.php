<?php
// Customers (R4, §6.9, §10.7). Master edits are global and take effect at once (last write wins, R20).
final class Customers
{
    public const CODE_RE = '/^[A-Z0-9][A-Z0-9._-]{0,19}$/';

    public static function out(array $c): array
    {
        return [
            'id' => $c['id'], 'code' => $c['code'], 'name' => $c['name'],
            'address' => $c['address'] ?? '', 'phone' => $c['phone'] ?? '', 'note' => $c['note'] ?? '',
            'waste_types' => $c['waste_types'] ?? [], 'active' => (bool) ($c['active'] ?? true),
        ];
    }

    public static function index(array $plan, int $id): ?int
    {
        foreach ($plan['customers'] ?? [] as $i => $c) {
            if ($c['id'] === $id) {
                return $i;
            }
        }
        return null;
    }

    private static function mustFind(array $plan, int $id): int
    {
        $i = self::index($plan, $id);
        if ($i === null) {
            throw new ApiError('NOT_FOUND', 404, 'id', null, 'Customer not found');
        }
        return $i;
    }

    // ---- GET -----------------------------------------------------------------------------

    /** GET /api/customers?q=&archived=0|1|all&routable=1&type=OTC */
    public static function list(Ctx $c): array
    {
        $plan = $c->plan();
        $types = Usage::typesByCode($plan);
        $q = trim((string) $c->query('q', ''));
        $archived = (string) $c->query('archived', '0');
        $routableOnly = $c->queryBool('routable');
        $type = $c->query('type');
        $routeCodes = Usage::routeCodesByCustomer($plan, $c->today);
        $taskTypes = [];
        foreach ($plan['tasks'] ?? [] as $t) {
            if (Usage::taskLive($t, $c->today) && !in_array($t['waste_type'], $taskTypes[$t['customer_id']] ?? [], true)) {
                $taskTypes[$t['customer_id']][] = $t['waste_type'];
            }
        }
        $order = array_flip(array_keys($types));
        $out = [];
        foreach ($plan['customers'] ?? [] as $cu) {
            $active = !empty($cu['active']);
            if (($archived === '0' && !$active) || ($archived === '1' && $active)) {
                continue;
            }
            if ($routableOnly && !Usage::customerRoutable($cu, $types)) {
                continue;
            }
            if ($type !== null && $type !== '' && !in_array($type, $cu['waste_types'] ?? [], true)) {
                continue;
            }
            if ($q !== '' && stripos($cu['name'] . "\n" . $cu['code'] . "\n" . ($cu['address'] ?? ''), $q) === false) {
                continue;
            }
            $tt = $taskTypes[$cu['id']] ?? [];
            usort($tt, static fn ($a, $b) => ($order[$a] ?? 99) <=> ($order[$b] ?? 99));
            $out[] = self::out($cu) + ['routes' => $routeCodes[$cu['id']] ?? [], 'tasks' => $tt];
        }
        usort($out, static fn ($a, $b) => [strtolower($a['name']), $a['id']] <=> [strtolower($b['name']), $b['id']]);
        return $out;
    }

    /** GET /api/customers/{id} */
    public static function get(Ctx $c): array
    {
        $plan = $c->plan();
        $cu = $plan['customers'][self::mustFind($plan, $c->intParam('id'))];
        $routes = [];
        foreach (Usage::routeStops($plan, $cu['id'], $c->today) as $ref) {
            $routes[$ref['route_id']] ??= ['route_id' => $ref['route_id'], 'code' => $ref['code'], 'name' => $ref['name'], 'type' => $ref['type']];
        }
        $tasks = [];
        foreach (Usage::liveTasksOf($plan, $cu['id'], $c->today) as $t) {
            $tasks[] = ['task_id' => $t['id'], 'waste_type' => $t['waste_type'], 'schedule' => Usage::taskSchedule($t)];
        }
        return self::out($cu) + ['routes' => array_values($routes), 'tasks' => $tasks];
    }

    // ---- writes --------------------------------------------------------------------------

    /** POST /api/customers {code?, name, address, phone, note, waste_types} -> 201 Customer */
    public static function create(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['code', 'name', 'address', 'phone', 'note', 'waste_types']);
        $plan = $c->plan();
        $id = (int) ($plan['seq']['customer'] ?? 0) + 1;
        $plan['seq']['customer'] = $id;
        $cu = [
            'id' => $id,
            'code' => '',
            'name' => V::str($b['name'] ?? null, 'name', 1, 100),
            'address' => V::optStr($b, 'address', 200),
            'phone' => V::optStr($b, 'phone', 40),
            'note' => V::optStr($b, 'note', 500),
            'waste_types' => self::normalizeTypes($b['waste_types'] ?? null, $plan, []),
            'active' => true,
        ];
        $code = isset($b['code']) && is_string($b['code']) ? strtoupper(trim($b['code'])) : '';
        if ($code === '') {
            for ($n = $id; self::codeTaken($plan, 'C' . sprintf('%04d', $n), 0); $n++) {
            }
            $code = 'C' . sprintf('%04d', $n);
        }
        $cu['code'] = self::checkCode($plan, $code, 0);
        $plan['customers'][] = $cu;
        $c->savePlan($plan);
        return $c->created(self::out($cu));
    }

    /** PATCH /api/customers/{id} {code?, name?, address?, phone?, note?, waste_types?, detach?, release_run?} */
    public static function update(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, ['code', 'name', 'address', 'phone', 'note', 'waste_types', 'detach', 'release_run']);
        $plan = $c->plan();
        $i = self::mustFind($plan, $c->intParam('id'));
        $cu = $plan['customers'][$i];
        if (array_key_exists('code', $b)) {
            $cu['code'] = self::checkCode($plan, strtoupper(trim(V::str($b['code'], 'code', 1, 20))), $cu['id']);
        }
        if (array_key_exists('name', $b)) {
            $cu['name'] = V::str($b['name'], 'name', 1, 100);
        }
        foreach (['address' => 200, 'phone' => 40, 'note' => 500] as $f => $max) {
            if (array_key_exists($f, $b)) {
                $cu[$f] = V::optStr($b, $f, $max);
            }
        }
        $detach = array_key_exists('detach', $b) && V::bool($b['detach'], 'detach');
        $releaseRun = array_key_exists('release_run', $b) && V::bool($b['release_run'], 'release_run');
        $removed = [];
        if (array_key_exists('waste_types', $b)) {
            $new = self::normalizeTypes($b['waste_types'], $plan, $cu['waste_types'] ?? []);
            $removedTypes = array_values(array_diff($cu['waste_types'] ?? [], $new));
            $types = Usage::typesByCode($plan);
            $lostRoutable = false;
            foreach ($removedTypes as $code) {
                if (!empty($types[$code]['routable'])) {
                    $lostRoutable = true;
                }
            }
            $routesToo = $lostRoutable && !Usage::customerRoutable(['waste_types' => $new], $types);
            [$plan, $removed] = self::detach($plan, $cu['id'], $removedTypes, $routesToo, $c->today);
            if ($removed !== [] && !$detach) {
                throw new ApiError('CUSTOMER_IN_USE', 409, 'waste_types', self::inUseDetails($removed));
            }
            $cu['waste_types'] = $new;
        }
        $plan['customers'][$i] = $cu;
        $c->savePlan($plan, ['release_run' => $releaseRun]);
        $out = self::out($cu);
        if ($detach) {
            $out['removed'] = $removed;
        }
        return $out;
    }

    /** POST /api/customers/{id}/archive {release_run?} -> {"removed":[…]} (detach every type, then active = false). */
    public static function archive(Ctx $c): array
    {
        V::only($c->body, ['release_run']);
        $releaseRun = array_key_exists('release_run', $c->body) && V::bool($c->body['release_run'], 'release_run');
        $plan = $c->plan();
        $i = self::mustFind($plan, $c->intParam('id'));
        $cu = $plan['customers'][$i];
        [$plan, $removed] = self::detach($plan, $cu['id'], $cu['waste_types'] ?? [], true, $c->today);
        $plan['customers'][$i]['active'] = false;
        $c->savePlan($plan, ['release_run' => $releaseRun]);
        return ['removed' => $removed];
    }

    /** POST /api/customers/{id}/restore -> Customer (only active = true; nothing is re-added). */
    public static function restore(Ctx $c): array
    {
        V::only($c->body, []);
        $plan = $c->plan();
        $i = self::mustFind($plan, $c->intParam('id'));
        $plan['customers'][$i]['active'] = true;
        $c->savePlan($plan);
        return self::out($plan['customers'][$i]);
    }

    // ---- rules ---------------------------------------------------------------------------

    /**
     * R4 waste_types: a non-empty list of existing codes (WASTE_TYPES_REQUIRED / UNKNOWN_WASTE_TYPE).
     * A newly added code must be active; a code already on the customer is kept even when inactive.
     * Returned de-duplicated, in waste-type order.
     */
    public static function normalizeTypes(mixed $v, array $plan, array $existing): array
    {
        if ($v === null || $v === []) {
            throw new ApiError('WASTE_TYPES_REQUIRED', 422, 'waste_types');
        }
        V::list($v, 'waste_types');
        $types = Usage::typesByCode($plan);
        $set = [];
        foreach ($v as $code) {
            if (!is_string($code) || !isset($types[$code])) {
                throw new ApiError('UNKNOWN_WASTE_TYPE', 422, 'waste_types', ['code' => $code]);
            }
            if (empty($types[$code]['active']) && !in_array($code, $existing, true)) {
                throw new ApiError('UNKNOWN_WASTE_TYPE', 422, 'waste_types', ['code' => $code, 'inactive' => true],
                    "Waste type $code is inactive");
            }
            $set[$code] = true;
        }
        return array_values(array_filter(array_keys($types), static fn ($code) => isset($set[$code])));
    }

    private static function codeTaken(array $plan, string $code, int $exceptId): bool
    {
        foreach ($plan['customers'] ?? [] as $cu) {
            if ($cu['id'] !== $exceptId && strcasecmp($cu['code'], $code) === 0) {
                return true;
            }
        }
        return false;
    }

    private static function checkCode(array $plan, string $code, int $exceptId): string
    {
        if (!preg_match(self::CODE_RE, $code)) {
            V::fail('code', 'The code must be 1-20 letters, digits, ".", "_" or "-"');
        }
        if (self::codeTaken($plan, $code, $exceptId)) {
            V::fail('code', "Customer code $code is already used");
        }
        return $code;
    }

    /**
     * R4 detach of customer $cid. When $routesToo, removes it from live route templates, from
     * overrides dated >= today and from one-off routes dated >= today. For each removed type it ends
     * recurring tasks (end = today - 1; a series starting >= today is deleted) and deletes one-off
     * tasks dated >= today. Bumps the rev of every changed route/task (R20).
     * @return array{0:array,1:list<array>} [new plan, removed items]
     */
    public static function detach(array $plan, int $cid, array $removedTypes, bool $routesToo, string $today): array
    {
        $removed = [];
        if ($routesToo) {
            $byId = [];
            foreach ($plan['routes'] as $k => $r) {
                $byId[$r['id']] = $k;
                if (Usage::routeLive($r, $today) && Usage::stopsHave($r['stops'] ?? [], $cid)) {
                    $plan['routes'][$k]['stops'] = self::withoutCustomer($r['stops'], $cid);
                    $plan['routes'][$k]['rev'] = (int) ($r['rev'] ?? 0) + 1;
                    $oneOff = Usage::isOneOff($r);
                    $removed[] = ['kind' => 'route', 'route_id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '',
                        'where' => $oneOff ? 'one-off' : 'template', 'date' => $oneOff ? $r['date'] : null];
                }
            }
            foreach ($plan['route_overrides'] ?? [] as $k => $o) {
                $rk = $byId[$o['route_id']] ?? null;
                if ($rk !== null && $o['date'] >= $today && is_array($o['stops'] ?? null) && Usage::stopsHave($o['stops'], $cid)) {
                    $plan['route_overrides'][$k]['stops'] = self::withoutCustomer($o['stops'], $cid);
                    $plan['routes'][$rk]['rev'] = (int) ($plan['routes'][$rk]['rev'] ?? 0) + 1;
                    $r = $plan['routes'][$rk];
                    $removed[] = ['kind' => 'route', 'route_id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '',
                        'where' => 'override', 'date' => $o['date']];
                }
            }
        }
        $deleteTaskIds = [];
        foreach ($plan['tasks'] ?? [] as $k => $t) {
            if ((int) $t['customer_id'] !== $cid || !in_array($t['waste_type'], $removedTypes, true) || !Usage::taskLive($t, $today)) {
                continue;
            }
            if (Usage::isOneOff($t) || ($t['start'] ?? '') >= $today) {
                $deleteTaskIds[] = $t['id'];
                $removed[] = ['kind' => 'task', 'task_id' => $t['id'], 'waste_type' => $t['waste_type'], 'action' => 'deleted'];
            } else {
                $plan['tasks'][$k]['end'] = Dates::addDays($today, -1);
                $plan['tasks'][$k]['rev'] = (int) ($t['rev'] ?? 0) + 1;
                $removed[] = ['kind' => 'task', 'task_id' => $t['id'], 'waste_type' => $t['waste_type'], 'action' => 'ended'];
            }
        }
        if ($deleteTaskIds !== []) {
            $plan['tasks'] = array_values(array_filter($plan['tasks'], static fn ($t) => !in_array($t['id'], $deleteTaskIds, true)));
            $plan['task_overrides'] = array_values(array_filter($plan['task_overrides'] ?? [],
                static fn ($o) => !in_array($o['task_id'], $deleteTaskIds, true)));
        }
        return [$plan, $removed];
    }

    private static function withoutCustomer(array $stops, int $cid): array
    {
        return array_values(array_filter($stops, static fn ($s) => (int) $s['customer_id'] !== $cid));
    }

    /** 409 CUSTOMER_IN_USE details: {"routes":[…],"tasks":[…]} (what a detach would remove). */
    private static function inUseDetails(array $removed): array
    {
        $routes = [];
        $tasks = [];
        foreach ($removed as $r) {
            if ($r['kind'] === 'route') {
                $routes[] = $r;
            } else {
                $tasks[] = $r;
            }
        }
        return ['routes' => $routes, 'tasks' => $tasks];
    }
}
