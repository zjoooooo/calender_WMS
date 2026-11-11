// Pure view logic of the office calendar (§5.8, §9.2): bucketing the server's occurrences per day,
// type / task filters, the legend, highlight and search (one matcher), and small text helpers.
// The client never computes a weekday, day class, status or lock for rules: those come from the payload.
// The only date arithmetic here (addDays) is for form defaults such as "end = D − 1".
import type { CalendarDay, CalendarResponse, RouteOccurrence, RouteType, RunStatus, TaskOccurrence } from '../api';

/** 'YYYY-MM-DD' + n days (UTC arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Natural code order: N2 before N10 (R5). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export interface Filters {
  /** Route types shown (R, S, ⚡A chips). */
  types: Record<RouteType, boolean>;
  /** Task waste types hidden (chip off). A code not listed is shown. */
  hiddenTaskTypes: string[];
}

export const ALL_TYPES: Record<RouteType, boolean> = { regular: true, special: true, adhoc: true };

export interface DaySummary {
  routes: number; // scheduled routes
  stops: number; // stops on scheduled routes
  tasks: number; // scheduled tasks
  paused: number; // holiday_skipped routes
}

export interface DayGroups {
  day: CalendarDay;
  /** Tasks group (§5.8 1), after the task filter. */
  tasks: TaskOccurrence[];
  /** Scheduled and cancelled routes (§5.8 2), after the type filter. */
  routes: RouteOccurrence[];
  /** holiday_skipped regular routes (§5.8 3), after the type filter. */
  paused: RouteOccurrence[];
  /** Counts of the whole day (filters do not change them). */
  summary: DaySummary;
  /** Every task of the day (unfiltered), for the collapsed line and the month chip tooltip. */
  allTasks: TaskOccurrence[];
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
  const tasks = byDate(data.tasks);
  return data.days.map((day) => {
    const r = routes.get(day.date) ?? [];
    const t = tasks.get(day.date) ?? [];
    const scheduled = r.filter((o) => o.status === 'scheduled');
    const summary: DaySummary = {
      routes: scheduled.length,
      stops: scheduled.reduce((n, o) => n + o.stops.length, 0),
      tasks: t.filter((o) => o.status === 'scheduled').length,
      paused: r.filter((o) => o.status === 'holiday_skipped').length,
    };
    const shown = r.filter((o) => filters.types[o.type] !== false);
    return {
      day,
      tasks: t.filter((o) => !filters.hiddenTaskTypes.includes(o.waste_type)),
      routes: shown.filter((o) => o.status !== 'holiday_skipped'),
      paused: shown.filter((o) => o.status === 'holiday_skipped'),
      summary,
      allTasks: t,
    };
  });
}

// ---- highlight and search (§9.2) -----------------------------------------------------------------

export interface Matcher {
  /** True while a highlight or a search is in force (everything else dims). */
  active: boolean;
  route: (o: RouteOccurrence) => boolean;
  task: (o: TaskOccurrence) => boolean;
  /** Legend chips: the code has at least one matching occurrence. */
  code: (code: string) => boolean;
}

const yes = () => true;

/**
 * Highlight and search are exclusive (the caller keeps only the last one used).
 * - Highlight: the code only, on every date; tasks dim.
 * - Search: routes by code, name or a stop customer's name or code; tasks by customer name or code.
 */
export function makeMatcher(data: CalendarResponse | undefined, hl: string | null, q: string): Matcher {
  if (hl) {
    return { active: true, route: (o) => o.code === hl, task: () => false, code: (c) => c === hl };
  }
  const needle = q.trim().toLowerCase();
  if (!needle) return { active: false, route: yes, task: yes, code: yes };
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
  return { active: true, route, task: (o) => custHit(o.customer_id), code: (c) => codes.has(c) };
}

// ---- legend (§9.2) ---------------------------------------------------------------------------------

export interface LegendItem {
  code: string;
  color: number;
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
    seen.set(o.code, { code: o.code, color: o.color, type: o.type, name: o.name });
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

/** Per customer: the waste types of the scheduled tasks on one date (stop label "also on: OTC task"). */
export function tasksByCustomer(tasks: TaskOccurrence[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const o of tasks) {
    if (o.status !== 'scheduled') continue;
    const list = m.get(o.customer_id) ?? [];
    if (!list.includes(o.waste_type)) list.push(o.waste_type);
    m.set(o.customer_id, list);
  }
  return m;
}

/** Counts for the collapsed tasks line: per waste type, plus how many are unclaimed today. */
export function taskGroupCounts(tasks: TaskOccurrence[]): { byType: [string, number][]; unclaimed: number } {
  const byType = new Map<string, number>();
  let unclaimed = 0;
  for (const o of tasks) {
    byType.set(o.waste_type, (byType.get(o.waste_type) ?? 0) + 1);
    if (o.run_status === 'not_started') unclaimed++;
  }
  return { byType: [...byType.entries()], unclaimed };
}

/** Month chip status dot (§8.3): green done, amber open, red incomplete, grey no record. */
export function statusDot(s: RunStatus | null): 'ok' | 'warn' | 'danger' | 'grey' | null {
  switch (s) {
    case 'done':
      return 'ok';
    case 'open':
      return 'warn';
    case 'incomplete':
      return 'danger';
    case 'no_record':
      return 'grey';
    default:
      return null;
  }
}

/** Job key of an occurrence for /api/runs/{date}/{job}: 'r5' or 't6'. */
export function jobOf(o: RouteOccurrence | TaskOccurrence): string {
  return o.kind === 'route' ? `r${o.route_id}` : `t${o.task_id}`;
}
