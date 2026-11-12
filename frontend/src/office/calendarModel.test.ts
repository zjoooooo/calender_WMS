// §13: the calendar's search and highlight filter, plus grouping, legend and polling decisions.
import { describe, expect, it } from 'vitest';
import type { CalendarResponse, RouteOccurrence } from '../api';
import {
  addDays,
  ALL_TYPES,
  dispatchSort,
  groupDays,
  legendItems,
  makeMatcher,
  MONTH_CELL_MAX,
  monthCellLines,
  monthWeeks,
  nextWorkDayAfter,
  pausedCounts,
  rangeContainsToday,
  routesByCustomer,
} from './calendarModel';

function route(p: Partial<RouteOccurrence> & { code: string; date: string; route_id: number }): RouteOccurrence {
  return {
    key: `r${p.route_id}@${p.date}`, kind: 'route', color: 1, type: 'regular', waste_type: 'REL', name: p.code + ' name', recurring: true,
    days: [1, 3, 5], sun: null, ph: null, status: 'scheduled', edited: false, frozen: false, note: '', rev: 1,
    copied_from: null, covered_by: [], stops: [], off_plan: [], run_status: 'planned', run: null, ...p,
  };
}
const stops = (...ids: number[]) => ids.map((id, i) => ({ seq: i + 1, customer_id: id, note: '', visit: null }));
const day = (date: string, extra = {}) => ({
  date, dow: 1, class: 'work' as const, holiday: null, past: false, in_month: true, can_create: [], totals: {}, provisional: false, ...extra,
});

const data: CalendarResponse = {
  from: '2026-11-09', to: '2026-11-15', today: '2026-11-11', prev_anchor: '2026-11-02', next_anchor: '2026-11-16',
  missing_holiday_years: [],
  days: [day('2026-11-11'), day('2026-11-12')],
  routes: [
    route({ route_id: 41, code: 'A1', type: 'adhoc', date: '2026-11-11', stops: stops(12) }),
    route({ route_id: 5, code: 'N1', name: 'North 1 · Woodlands', date: '2026-11-11', stops: stops(12, 40) }),
    route({ route_id: 6, code: 'E2', name: 'East 2 · Bedok', date: '2026-11-11', stops: stops(7) }),
    route({ route_id: 5, code: 'N1', date: '2026-11-12', status: 'cancelled', stops: stops(12, 40) }),
    route({ route_id: 9, code: 'S1', type: 'special', date: '2026-11-12', status: 'holiday_skipped', stops: stops(21) }),
  ],
  customers: {
    '7': { id: 7, code: 'C0007', name: 'Kopi Tiam 88', address: '', waste_types: ['REL'], active: true },
    '12': { id: 12, code: 'C0012', name: 'ABC Restaurant', address: '', waste_types: ['REL', 'OTC'], active: true },
    '21': { id: 21, code: 'C0021', name: 'Market', address: '', waste_types: ['REL'], active: true },
    '40': { id: 40, code: 'C0040', name: 'Golden Bakery', address: '', waste_types: ['REL', 'COMPACTOR'], active: true },
  },
};

describe('search and highlight (§9.2)', () => {
  it('no highlight and no search: nothing dims', () => {
    const m = makeMatcher(data, null, '  ');
    expect(m.active).toBe(false);
    expect(data.routes.every(m.route)).toBe(true);
  });

  it('highlight matches the code on every date', () => {
    const m = makeMatcher(data, 'N1', '');
    expect(data.routes.filter(m.route).map((o) => o.key)).toEqual(['r5@2026-11-11', 'r5@2026-11-12']);
    expect(m.code('N1')).toBe(true);
    expect(m.code('E2')).toBe(false);
  });

  it('search by route code or name, case-insensitive', () => {
    expect(data.routes.filter(makeMatcher(data, null, 'e2').route).map((o) => o.code)).toEqual(['E2']);
    expect(data.routes.filter(makeMatcher(data, null, 'woodlands').route).map((o) => o.code)).toEqual(['N1']);
  });

  it('search by a customer name or code finds its routes', () => {
    const m = makeMatcher(data, null, 'kopi');
    expect(data.routes.filter(m.route).map((o) => o.code)).toEqual(['E2']);
    const abc = makeMatcher(data, null, 'abc rest');
    expect(data.routes.filter(abc.route).map((o) => o.key)).toEqual(['r41@2026-11-11', 'r5@2026-11-11', 'r5@2026-11-12']);
    expect(abc.code('A1')).toBe(true);
    expect(abc.code('E2')).toBe(false);
    expect(data.routes.filter(makeMatcher(data, null, 'c0040').route).map((o) => o.key)).toEqual(['r5@2026-11-11', 'r5@2026-11-12']);
  });

  it('highlight wins over a search text passed at the same time', () => {
    const m = makeMatcher(data, 'E2', 'abc');
    expect(data.routes.filter(m.route).map((o) => o.code)).toEqual(['E2']);
  });
});

describe('grouping, filters and legend', () => {
  it('splits a day into routes and the paused group, with unfiltered counts', () => {
    const [wed, thu] = groupDays(data, { types: ALL_TYPES });
    expect(wed.routes.map((o) => o.code)).toEqual(['A1', 'N1', 'E2']);
    expect(wed.summary).toEqual({ routes: 3, stops: 4, paused: 0 });
    expect(thu.routes.map((o) => o.status)).toEqual(['cancelled']);
    expect(thu.paused.map((o) => o.code)).toEqual(['S1']);
    expect(thu.summary).toEqual({ routes: 0, stops: 0, paused: 1 });
  });

  it('type chips hide rows but not the counts', () => {
    const [wed, thu] = groupDays(data, { types: { regular: true, special: false, adhoc: false } });
    expect(wed.routes.map((o) => o.code)).toEqual(['N1', 'E2']);
    expect(wed.summary.routes).toBe(3);
    expect(thu.paused).toEqual([]);
    expect(thu.summary.paused).toBe(1);
  });

  it('legend: unique codes, sorted A, R, S then naturally; filtered by type', () => {
    expect(legendItems(data, { types: ALL_TYPES }).map((l) => l.code)).toEqual(['A1', 'E2', 'N1', 'S1']);
    expect(legendItems(data, { types: { regular: false, special: true, adhoc: true } }).map((l) => l.code)).toEqual(['A1', 'S1']);
  });
});

describe('helpers', () => {
  it('polls only while the range contains the server today', () => {
    expect(rangeContainsToday(data)).toBe(true);
    expect(rangeContainsToday({ from: '2026-11-16', to: '2026-11-22', today: '2026-11-11' })).toBe(false);
    expect(rangeContainsToday(undefined)).toBe(false);
  });

  it('dispatch order for today: Needs driver, Not started, Working, Done', () => {
    const list = [{ run_status: 'done' }, { run_status: 'active' }, { run_status: 'open' }, { run_status: 'not_started' }] as { run_status: any }[];
    expect(dispatchSort(list).map((o) => o.run_status)).toEqual(['open', 'not_started', 'active', 'done']);
  });

  it('also-on map and date arithmetic', () => {
    const m = routesByCustomer(data.routes.filter((o) => o.date === '2026-11-11'), 5);
    expect(m.get(12)).toEqual(['A1']);
    expect(m.get(40)).toBeUndefined();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('month cell collapse (§9.2)', () => {
  const routes = (n: number, date = '2026-11-12') =>
    Array.from({ length: n }, (_, i) => route({ route_id: 100 + i, code: `R${i + 1}`, date, stops: stops(7 + i) }));
  const keys = (list: { key: string }[]) => list.map((o) => o.key);

  it('shows up to 4 lines with no control', () => {
    expect(MONTH_CELL_MAX).toBe(4);
    for (const n of [0, 1, 4]) {
      const c = monthCellLines({ routes: routes(n) }, false);
      expect(c.collapsible).toBe(false);
      expect(c.open).toBe(true);
      expect(c.shown).toHaveLength(n);
      expect(c.hidden).toEqual([]);
    }
  });

  it('more than 4: the first 4 lines, the rest behind "N more", in day order', () => {
    const c = monthCellLines({ routes: routes(5) }, false);
    expect(c.collapsible).toBe(true);
    expect(c.open).toBe(false);
    expect(keys(c.shown)).toEqual(keys(routes(4)));
    expect(keys(c.hidden)).toEqual(['r104@2026-11-12']);
    const big = monthCellLines({ routes: routes(14) }, false);
    expect(big.shown).toHaveLength(4);
    expect(big.hidden).toHaveLength(10);
    expect(keys(big.items)).toEqual(keys(routes(14)));
  });

  it('expanded shows every line and keeps the control (Show less)', () => {
    const c = monthCellLines({ routes: routes(13) }, true);
    expect(c.collapsible).toBe(true);
    expect(c.open).toBe(true);
    expect(c.auto).toBe(false);
    expect(c.shown).toHaveLength(13);
    expect(c.hidden).toEqual([]);
  });

  it('opens by itself while the search or highlight matches a hidden line, not a shown one', () => {
    const list = routes(6);
    const hl = (code: string) => ({ active: true, route: (o: RouteOccurrence) => o.code === code });
    const hidden = monthCellLines({ routes: list }, false, hl('R6'));
    expect(hidden.open && hidden.auto).toBe(true);
    expect(hidden.shown).toHaveLength(6);
    const shown = monthCellLines({ routes: list }, false, hl('R2'));
    expect(shown.open || shown.auto).toBe(false);
    const off = monthCellLines({ routes: list }, false, { active: false, route: () => true });
    expect(off.open).toBe(false);
    // a search by customer opens the cell when the customer is on a hidden line (40 = Golden Bakery)
    const withCustomer = [...routes(4), route({ route_id: 200, code: 'G1', date: '2026-11-12', stops: stops(40) })];
    const byCustomer = monthCellLines({ routes: withCustomer }, false, makeMatcher(data, null, 'golden'));
    expect(byCustomer.auto).toBe(true);
  });

  it('a custom limit', () => {
    expect(monthCellLines({ routes: routes(3) }, false, undefined, 2).hidden).toHaveLength(1);
  });

  it('month weeks: only the week rows that hold a day of the month', () => {
    const g = (n: number, inMonth: (i: number) => boolean) => Array.from({ length: n }, (_, i) => ({ day: { in_month: inMonth(i) } }));
    // Nov 2026, Sunday first: Nov 1 .. Nov 30 are cells 0..29 of 42 -> 5 rows.
    expect(monthWeeks(g(42, (i) => i < 30)).map((w) => w.length)).toEqual([7, 7, 7, 7, 7]);
    // Aug 2026: Sat 1 is cell 6, Mon 31 is cell 36 -> 6 rows.
    expect(monthWeeks(g(42, (i) => i >= 6 && i <= 36))).toHaveLength(6);
    // Feb 2026: Sun 1 .. Sat 28 -> 4 rows.
    expect(monthWeeks(g(42, (i) => i < 28))).toHaveLength(4);
  });
});

describe('Move to work day default (OFF-1 / REV-2)', () => {
  const hol = new Set(['2026-11-08', '2026-11-09', '2026-12-25', '2026-12-01']);
  const isHol = (d: string) => hol.has(d);
  it('is the first work day after the paused date, not the next work day after today', () => {
    expect(nextWorkDayAfter('2026-12-25', isHol, '2026-11-11')).toBe('2026-12-26'); // Christmas (Fri) -> Sat 26 Dec
    expect(nextWorkDayAfter('2026-12-01', isHol, '2026-11-11')).toBe('2026-12-02'); // a Tue PH -> Wed
  });
  it('skips Sundays and holidays and never returns a date before today', () => {
    expect(nextWorkDayAfter('2026-11-07', isHol, '2026-11-01')).toBe('2026-11-10'); // Sat -> Sun 8 (PH) -> Mon 9 (PH) -> Tue
    expect(nextWorkDayAfter('2026-11-05', isHol, '2026-11-11')).toBe('2026-11-11');
  });
});

describe('paused PH counts (OFF-5)', () => {
  it('counts the routes that still need a decision apart from the covered ones', () => {
    const list = [
      route({ code: 'C1', date: '2026-12-01', route_id: 1, status: 'holiday_skipped', covered_by: [{ route_id: 9, code: 'C1-01', date: '2026-12-01' }] }),
      route({ code: 'C2', date: '2026-12-01', route_id: 2, status: 'holiday_skipped' }),
      route({ code: 'C3', date: '2026-12-01', route_id: 3, status: 'holiday_skipped' }),
    ];
    expect(pausedCounts(list)).toEqual({ open: 2, covered: 1 });
    expect(pausedCounts([])).toEqual({ open: 0, covered: 0 });
  });
});
