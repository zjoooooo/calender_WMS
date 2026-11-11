// §13: the calendar's search and highlight filter, plus grouping, legend and polling decisions.
import { describe, expect, it } from 'vitest';
import type { CalendarResponse, RouteOccurrence, TaskOccurrence } from '../api';
import {
  addDays,
  ALL_TYPES,
  dispatchSort,
  groupDays,
  legendItems,
  makeMatcher,
  rangeContainsToday,
  routesByCustomer,
  taskGroupCounts,
} from './calendarModel';

function route(p: Partial<RouteOccurrence> & { code: string; date: string; route_id: number }): RouteOccurrence {
  return {
    key: `r${p.route_id}@${p.date}`, kind: 'route', color: 1, type: 'regular', name: p.code + ' name', recurring: true,
    days: [1, 3, 5], sun: null, ph: null, status: 'scheduled', edited: false, frozen: false, note: '', rev: 1,
    copied_from: null, covered_by: [], stops: [], off_plan: [], run_status: 'planned', run: null, ...p,
  };
}
function task(p: Partial<TaskOccurrence> & { task_id: number; date: string; customer_id: number }): TaskOccurrence {
  return {
    key: `t${p.task_id}@${p.date}`, kind: 'task', waste_type: 'OTC', recurring: false, days: null, status: 'scheduled',
    edited: false, frozen: false, note: '', rev: 1, copied_from: null, covered_by: [], visit: null, run_status: 'planned', run: null, ...p,
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
  tasks: [
    task({ task_id: 6, date: '2026-11-11', customer_id: 12, run_status: 'not_started' }),
    task({ task_id: 3, date: '2026-11-12', customer_id: 40, waste_type: 'COMPACTOR' }),
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
    expect(data.tasks.every(m.task)).toBe(true);
  });

  it('highlight matches the code on every date and dims every task', () => {
    const m = makeMatcher(data, 'N1', '');
    expect(data.routes.filter(m.route).map((o) => o.key)).toEqual(['r5@2026-11-11', 'r5@2026-11-12']);
    expect(data.tasks.some(m.task)).toBe(false);
    expect(m.code('N1')).toBe(true);
    expect(m.code('E2')).toBe(false);
  });

  it('search by route code or name, case-insensitive', () => {
    expect(data.routes.filter(makeMatcher(data, null, 'e2').route).map((o) => o.code)).toEqual(['E2']);
    expect(data.routes.filter(makeMatcher(data, null, 'woodlands').route).map((o) => o.code)).toEqual(['N1']);
  });

  it('search by a customer name or code finds its routes and its tasks', () => {
    const m = makeMatcher(data, null, 'kopi');
    expect(data.routes.filter(m.route).map((o) => o.code)).toEqual(['E2']);
    expect(data.tasks.filter(m.task)).toEqual([]);
    const abc = makeMatcher(data, null, 'abc rest');
    expect(data.routes.filter(abc.route).map((o) => o.key)).toEqual(['r41@2026-11-11', 'r5@2026-11-11', 'r5@2026-11-12']);
    expect(data.tasks.filter(abc.task).map((o) => o.key)).toEqual(['t6@2026-11-11']);
    expect(abc.code('A1')).toBe(true);
    expect(abc.code('E2')).toBe(false);
    expect(data.tasks.filter(makeMatcher(data, null, 'c0040').task).map((o) => o.task_id)).toEqual([3]);
  });

  it('highlight wins over a search text passed at the same time', () => {
    const m = makeMatcher(data, 'E2', 'abc');
    expect(data.routes.filter(m.route).map((o) => o.code)).toEqual(['E2']);
  });
});

describe('grouping, filters and legend', () => {
  it('splits a day into tasks, routes and the paused group, with unfiltered counts', () => {
    const [wed, thu] = groupDays(data, { types: ALL_TYPES, hiddenTaskTypes: [] });
    expect(wed.routes.map((o) => o.code)).toEqual(['A1', 'N1', 'E2']);
    expect(wed.summary).toEqual({ routes: 3, stops: 4, tasks: 1, paused: 0 });
    expect(thu.routes.map((o) => o.status)).toEqual(['cancelled']);
    expect(thu.paused.map((o) => o.code)).toEqual(['S1']);
    expect(thu.summary).toEqual({ routes: 0, stops: 0, tasks: 1, paused: 1 });
  });

  it('type chips and task chips hide rows but not the counts', () => {
    const [wed, thu] = groupDays(data, { types: { regular: true, special: true, adhoc: false }, hiddenTaskTypes: ['COMPACTOR'] });
    expect(wed.routes.map((o) => o.code)).toEqual(['N1', 'E2']);
    expect(wed.summary.routes).toBe(3);
    expect(thu.tasks).toEqual([]);
    expect(thu.allTasks).toHaveLength(1);
  });

  it('legend: unique codes, sorted A, R, S then naturally; filtered by type', () => {
    expect(legendItems(data, { types: ALL_TYPES, hiddenTaskTypes: [] }).map((l) => l.code)).toEqual(['A1', 'E2', 'N1', 'S1']);
    expect(legendItems(data, { types: { regular: false, special: true, adhoc: true }, hiddenTaskTypes: [] }).map((l) => l.code)).toEqual(['A1', 'S1']);
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

  it('also-on map, task counts and date arithmetic', () => {
    const m = routesByCustomer(data.routes.filter((o) => o.date === '2026-11-11'), 5);
    expect(m.get(12)).toEqual(['A1']);
    expect(m.get(40)).toBeUndefined();
    expect(taskGroupCounts(data.tasks)).toEqual({ byType: [['OTC', 1], ['COMPACTOR', 1]], unclaimed: 1 });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
