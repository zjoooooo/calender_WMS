// Pure view logic of the office calendar (§5.8, §9.2): bucketing the server's occurrences per day,
// type filters, the legend, highlight and search (one matcher), and small text helpers.
// The client never computes a weekday, day class, status or lock for rules: those come from the payload.
// The only date arithmetic here (addDays, nextWorkDayAfter) is for form defaults such as "end = D − 1".
import type { CalendarDay, CalendarResponse, RouteOccurrence, RouteType, RunStatus } from '../api';

/** 'YYYY-MM-DD' + n days (UTC arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Form default of "Move to work day…" (R15, §6.4): the first Monday–Saturday after `date` that is not a
 * known holiday and not before `min` (today). Only a default: the server's suggest-code still checks the
 * target's day class. '' when nothing is found within 60 days.
 */
export function nextWorkDayAfter(date: string, isHoliday: (d: string) => boolean, min = ''): string {
  let d = date;
  for (let i = 0; i < 60; i++) {
    d = addDays(d, 1);
    const sunday = new Date(d + 'T00:00:00Z').getUTCDay() === 0;
    if (!sunday && !isHoliday(d) && d >= min) return d;
  }
  return '';
}

/** Natural code order: N2 before N10 (R5). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export interface Filters {
  /** Route types shown (R, S, ⚡A chips). */
  types: Record<RouteType, boolean>;
}

export const ALL_TYPES: Record<RouteType, boolean> = { regular: true, special: true, adhoc: true };

export interface DaySummary {
  routes: number; // scheduled routes
  stops: number; // stops on scheduled routes
  paused: number; // holiday_skipped routes
}

export interface DayGroups {
  day: CalendarDay;
  /** Scheduled and cancelled routes (§5.8 2), after the type filter. */
  routes: RouteOccurrence[];
  /** holiday_skipped regular routes (§5.8 3), after the type filter. */
  paused: RouteOccurrence[];
  /** Counts of the whole day (filters do not change them). */
  summary: DaySummary;
}

export function byDate<T extends { date: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.date);
    if (list) list.push(it);
    else m.set(it.date, [it]);
  }
  return m;
}

/** Splits the payload into day columns, keeping the server's §5.8 order. */
export function groupDays(data: CalendarResponse, filters: Filters): DayGroups[] {
  const routes = byDate(data.routes);
  return data.days.map((day) => {
    const r = routes.get(day.date) ?? [];
    const scheduled = r.filter((o) => o.status === 'scheduled');
    const summary: DaySummary = {
      routes: scheduled.length,
      stops: scheduled.reduce((n, o) => n + o.stops.length, 0),
      paused: r.filter((o) => o.status === 'holiday_skipped').length,
    };
    const shown = r.filter((o) => filters.types[o.type] !== false);
    return {
      day,
      routes: shown.filter((o) => o.status !== 'holiday_skipped'),
      paused: shown.filter((o) => o.status === 'holiday_skipped'),
      summary,
    };
  });
}

// ---- highlight and search (§9.2) -----------------------------------------------------------------

export interface Matcher {
  /** True while a highlight or a search is in force (everything else dims). */
  active: boolean;
  route: (o: RouteOccurrence) => boolean;
  /** Legend chips: the code has at least one matching occurrence. */
  code: (code: string) => boolean;
}

const yes = () => true;

/**
 * Highlight and search are exclusive (the caller keeps only the last one used).
 * - Highlight: the code only, on every date.
 * - Search: routes by code, name or a stop customer's name or code.
 */
export function makeMatcher(data: CalendarResponse | undefined, hl: string | null, q: string): Matcher {
  if (hl) {
    return { active: true, route: (o) => o.code === hl, code: (c) => c === hl };
  }
  const needle = q.trim().toLowerCase();
  if (!needle) return { active: false, route: yes, code: yes };
  const customers = data?.customers ?? {};
  const custHit = (id: number) => {
    const c = customers[String(id)];
    return !!c && (c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle));
  };
  const route = (o: RouteOccurrence) =>
    o.code.toLowerCase().includes(needle) ||
    o.name.toLowerCase().includes(needle) ||
    o.stops.some((s) => custHit(s.customer_id)) ||
    (o.off_plan ?? []).some((s) => custHit(s.customer_id));
  const codes = new Set((data?.routes ?? []).filter(route).map((o) => o.code));
  return { active: true, route, code: (c) => codes.has(c) };
}

/** Paused PH routes (§6.4): how many still need a decision and how many a copy already covers. */
export function pausedCounts(list: Pick<RouteOccurrence, 'covered_by'>[]): { open: number; covered: number } {
  const covered = list.filter((o) => o.covered_by.length > 0).length;
  return { open: list.length - covered, covered };
}

// ---- month cell (§9.2) -------------------------------------------------------------------------------

/** A month cell shows at most this many lines before it collapses ("N more"). */
export const MONTH_CELL_MAX = 4;

export type CellItem = RouteOccurrence;

export interface MonthCellLines {
  /** Every line of the cell: routes (day order), after the type filters. */
  items: CellItem[];
  /** The lines drawn now. */
  shown: CellItem[];
  /** The lines behind "N more" (empty while the cell is open). */
  hidden: CellItem[];
  /** More than `max` lines: the cell has the "N more" / "Show less" control. */
  collapsible: boolean;
  /** Every line is drawn. */
  open: boolean;
  /** Open only because the search or highlight matches a line that would be hidden. */
  auto: boolean;
}

/**
 * Collapse rule of a month cell: up to `max` lines are all shown; with more, the first `max` are shown and
 * the rest sit behind "N more" until the office expands the cell (`expanded`, kept per date by the page) or
 * a search / highlight matches one of the hidden lines. Paused PH routes are not lines (own "⏸ N" line).
 */
export function monthCellLines(
  g: Pick<DayGroups, 'routes'>,
  expanded: boolean,
  matcher?: Pick<Matcher, 'active' | 'route'>,
  max: number = MONTH_CELL_MAX,
): MonthCellLines {
  const items: CellItem[] = g.routes;
  const collapsible = items.length > max;
  const matches = (o: CellItem) => matcher!.route(o);
  const auto = collapsible && !expanded && !!matcher?.active && items.slice(max).some(matches);
  const open = !collapsible || expanded || auto;
  return {
    items,
    shown: open ? items : items.slice(0, max),
    hidden: open ? [] : items.slice(max),
    collapsible,
    open,
    auto,
  };
}

/** The month grid's week rows (7 days each) that hold at least one day of the month: 4, 5 or 6 rows. */
export function monthWeeks<T extends { day: Pick<CalendarDay, 'in_month'> }>(groups: T[]): T[][] {
  const weeks: T[][] = [];
  for (let i = 0; i < groups.length; i += 7) {
    const w = groups.slice(i, i + 7);
    if (w.some((g) => g.day.in_month)) weeks.push(w);
  }
  return weeks;
}

// ---- progress colour (§9.2) ------------------------------------------------------------------------

/** The colour of a route's code on the calendar: how far the route is, not which route it is. */
export type Tone = 'idle' | 'early' | 'late' | 'done' | 'problem';
export const TONES: Tone[] = ['idle', 'early', 'late', 'done', 'problem'];

/**
 * idle: not started (also a future day) · early: under way, less than half of the stops have a result ·
 * late: under way, half or more · done: every stop collected · problem: a past day that was not finished or
 * has no record, a route that needs a driver, or a stop that was not collected. A cancelled or paused
 * occurrence has no colour (null).
 */
export function routeTone(o: Pick<RouteOccurrence, 'status' | 'run_status' | 'run'>): Tone | null {
  if (o.status !== 'scheduled') return null;
  const run = o.run;
  if ((run?.missed ?? 0) > 0 || o.run_status === 'incomplete' || o.run_status === 'no_record' || o.run_status === 'open') return 'problem';
  if (o.run_status === 'done') return 'done';
  if (o.run_status === 'active') return run && run.total > 0 && (run.collected + run.missed) * 2 >= run.total ? 'late' : 'early';
  return 'idle';
}

// ---- legend (§9.2) ---------------------------------------------------------------------------------

export interface LegendItem {
  code: string;
  type: RouteType;
  name: string;
}

const TYPE_RANK: Record<RouteType, number> = { adhoc: 0, regular: 1, special: 2 };

/** "North 1 · Woodlands" -> "North 1". */
export function shortName(name: string): string {
  return name.split(' · ')[0];
}

/** Every route code in the visible range (after the type filter), sorted A, R, S and then by code. */
export function legendItems(data: CalendarResponse | undefined, filters: Filters): LegendItem[] {
  const seen = new Map<string, LegendItem>();
  for (const o of data?.routes ?? []) {
    if (filters.types[o.type] === false || seen.has(o.code)) continue;
    seen.set(o.code, { code: o.code, type: o.type, name: o.name });
  }
  return [...seen.values()].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || naturalCompare(a.code, b.code));
}

// ---- misc --------------------------------------------------------------------------------------------

/** Poll every 30 s only while the range contains today (R36). Uses the server's today. */
export function rangeContainsToday(data: Pick<CalendarResponse, 'from' | 'to' | 'today'> | undefined): boolean {
  return !!data && data.from <= data.today && data.today <= data.to;
}

/** Today's day drawer is the dispatch board: Needs driver, Not started, Working, Done (§8.3). */
const DISPATCH_ORDER: Record<string, number> = { open: 0, not_started: 1, active: 2, done: 3 };
export function dispatchSort<T extends { run_status: RunStatus | null }>(list: T[]): T[] {
  return list
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (DISPATCH_ORDER[a.o.run_status ?? ''] ?? 4) - (DISPATCH_ORDER[b.o.run_status ?? ''] ?? 4) || a.i - b.i)
    .map((x) => x.o);
}

/** Per customer: the codes of the scheduled routes on one date (picker label "also on N2"). */
export function routesByCustomer(routes: RouteOccurrence[], exceptRouteId?: number): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const o of routes) {
    if (o.status !== 'scheduled' || o.route_id === exceptRouteId) continue;
    for (const s of o.stops) {
      const list = m.get(s.customer_id) ?? [];
      if (!list.includes(o.code)) list.push(o.code);
      m.set(s.customer_id, list);
    }
  }
  return m;
}

/** Job key of an occurrence for /api/runs/{date}/{job}: 'r5'. */
export function jobOf(o: RouteOccurrence): string {
  return `r${o.route_id}`;
}
