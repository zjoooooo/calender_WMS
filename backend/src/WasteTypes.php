<?php
// Waste types (R3, §10.7). Array order is display order. Never hard-deleted, only deactivated.
// code, unit and routable never change. A stored `recurring_tasks` (the old task feature) is ignored.
final class WasteTypes
{
    public const FIELDS = ['code', 'name', 'abbr', 'unit', 'weigh_method', 'routable', 'confirm_over', 'active'];

    public static function out(array $t): array
    {
        return [
            'code' => $t['code'], 'name' => $t['name'], 'abbr' => $t['abbr'], 'unit' => $t['unit'],
            'weigh_method' => $t['weigh_method'], 'routable' => (bool) $t['routable'],
            'confirm_over' => $t['confirm_over'] ?? null,
            'active' => (bool) $t['active'],
        ];
    }

    private static function index(array $plan, string $code): ?int
    {
        foreach ($plan['waste_types'] ?? [] as $i => $t) {
            if ($t['code'] === $code) {
                return $i;
            }
        }
        return null;
    }

    /** GET /api/waste-types */
    public static function list(Ctx $c): array
    {
        return array_map([self::class, 'out'], $c->plan()['waste_types'] ?? []);
    }

    /** POST /api/waste-types (admin) -> 201 type */
    public static function create(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, self::FIELDS);
        $plan = $c->plan();
        $code = V::regex($b['code'] ?? null, 'code', '/^[A-Z0-9_]{1,10}$/', 'The code must be 1-10 of A-Z, 0-9 or _');
        if (self::index($plan, $code) !== null) {
            V::fail('code', "Waste type $code already exists");
        }
        $t = [
            'code' => $code,
            'name' => V::str($b['name'] ?? null, 'name', 1, 30),
            'abbr' => self::abbr($b['abbr'] ?? $code),
            'unit' => V::str($b['unit'] ?? 'kg', 'unit', 1, 6),
            'weigh_method' => V::enum($b['weigh_method'] ?? 'on_site', 'weigh_method', ['on_site', 'weighbridge']),
            'routable' => V::bool($b['routable'] ?? false, 'routable'),
            'confirm_over' => self::confirmOver($b['confirm_over'] ?? null),
            'active' => V::bool($b['active'] ?? true, 'active'),
        ];
        $plan['waste_types'][] = $t;
        $c->savePlan($plan);
        return $c->created(self::out($t));
    }

    /** PATCH /api/waste-types/{code} (admin) {name?, abbr?, weigh_method?, confirm_over?, active?} */
    public static function update(Ctx $c): array
    {
        $b = $c->body;
        V::only($b, self::FIELDS);
        $plan = $c->plan();
        $i = self::index($plan, $c->param('code'));
        if ($i === null) {
            throw new ApiError('NOT_FOUND', 404, 'code', null, 'Waste type not found');
        }
        $t = $plan['waste_types'][$i];
        // code, unit and routable never change (R3). A form may resend them unchanged.
        foreach (['code', 'unit', 'routable'] as $f) {
            if (array_key_exists($f, $b) && $b[$f] !== $t[$f]) {
                V::fail($f, "'$f' of a waste type cannot change: create a new type instead");
            }
        }
        if (array_key_exists('name', $b)) {
            $t['name'] = V::str($b['name'], 'name', 1, 30);
        }
        if (array_key_exists('abbr', $b)) {
            $t['abbr'] = self::abbr($b['abbr']);
        }
        if (array_key_exists('weigh_method', $b)) {
            $t['weigh_method'] = V::enum($b['weigh_method'], 'weigh_method', ['on_site', 'weighbridge']);
        }
        if (array_key_exists('confirm_over', $b)) {
            $t['confirm_over'] = self::confirmOver($b['confirm_over']);
        }
        if (array_key_exists('active', $b)) {
            $active = V::bool($b['active'], 'active');
            if (!$active && !empty($t['active'])) {
                self::guardDeactivate($plan, $t, $c->today);
            }
            $t['active'] = $active;
        }
        $plan['waste_types'][$i] = $t;
        $c->savePlan($plan);
        return self::out($t);
    }

    /** PUT /api/waste-types/order {"codes":[…every code…]} (admin) -> the reordered list */
    public static function order(Ctx $c): array
    {
        V::only($c->body, ['codes']);
        $codes = V::list($c->body['codes'] ?? null, 'codes');
        $plan = $c->plan();
        $current = array_column($plan['waste_types'] ?? [], 'code');
        $sortedA = $codes;
        $sortedB = $current;
        sort($sortedA);
        sort($sortedB);
        if ($sortedA !== $sortedB) {
            V::fail('codes', 'codes must list every waste type code exactly once');
        }
        $byCode = Usage::typesByCode($plan);
        $plan['waste_types'] = array_map(static fn ($code) => $byCode[$code], $codes);
        $pos = array_flip($codes);
        // Customers store their types in waste-type order (R4).
        foreach ($plan['customers'] ?? [] as $k => $cu) {
            $list = $cu['waste_types'] ?? [];
            usort($list, static fn ($a, $b) => ($pos[$a] ?? 999) <=> ($pos[$b] ?? 999));
            $plan['customers'][$k]['waste_types'] = $list;
        }
        $c->savePlan($plan);
        return array_map([self::class, 'out'], $plan['waste_types']);
    }

    /**
     * R3 deactivation guard: a routable type cannot be deactivated while a route that collects it runs
     * today or later (409 WASTE_TYPE_IN_USE {routes}). A non-routable type can always be deactivated:
     * nothing is planned for it, it only leaves the driver's pick list.
     */
    public static function guardDeactivate(array $plan, array $type, string $today): void
    {
        if (empty($type['routable'])) {
            return;
        }
        $routes = [];
        $series = Usage::seriesMap($plan);
        foreach ($plan['routes'] ?? [] as $r) {
            if (Usage::routeType($r) === $type['code'] && Usage::routeLive($r, $today)) {
                $routes[$series[(int) $r['id']] ?? (int) $r['id']] ??= ['route_id' => $r['id'], 'code' => $r['code'], 'name' => $r['name'] ?? '', 'type' => $r['type']];
            }
        }
        if ($routes !== []) {
            throw new ApiError('WASTE_TYPE_IN_USE', 409, 'active', ['routes' => array_values($routes)]);
        }
    }

    private static function abbr(mixed $v): string
    {
        return V::regex($v, 'abbr', '/^[A-Z0-9]{1,10}$/', 'The abbreviation must be 1-10 of A-Z or 0-9');
    }

    private static function confirmOver(mixed $v): int|float|null
    {
        return $v === null ? null : V::number($v, 'confirm_over', 0, 99999.9);
    }
}
