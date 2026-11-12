// Split routes (R12 / R14). A "this date and following" save or a schedule change from D ends the route
// record at D − 1 and continues it as a new record with the same code and type from D. To the office it is
// still ONE route, and the server treats it so: an edit or delete of a live segment also reaches the other
// segments that run today or later. These helpers mirror that grouping on the client, from
// GET /api/routes?ended=1, so that the forms and dialogs show the whole route (its real start and end,
// every part a delete removes) and send an end or a start to the segment it belongs to.
// The segments are grouped by the server's `series` (the id of the route's first record), which the server
// sends for every recurring route. The code-and-dates grouping below is only a fallback for a payload without
// it (the server itself never guesses). `route_start` / `route_end`, when given, are the server's real period.
import { useQuery } from '@tanstack/react-query';
import { listRoutes, type IsoDate, type RouteType } from '../api';
import { addDays } from './calendarModel';

/** The fields of a route record the grouping needs (a RouteListItem or a Route). */
export interface Segment {
  id: number;
  code: string;
  type: RouteType;
  rev: number;
  recurring?: boolean;
  date?: IsoDate | null;
  start?: IsoDate | null;
  end?: IsoDate | null;
  days?: number[] | null;
  sun?: boolean | null;
  ph?: boolean | null;
  /** Additive server fields: the split route this record belongs to, and that route's real period. */
  series?: number | null;
  route_start?: IsoDate | null;
  route_end?: IsoDate | null;
}

const oneOff = (r: Segment) => !!r.date || r.recurring === false;

/** Plan::chain: route `id` and every recurring route chained to it (same code and type, each period starting
 *  the day after the previous one ends), sorted by start. A one-off, or an unknown id, is its own chain. */
export function routeChain<T extends Segment>(routes: T[], id: number): T[] {
  const r = routes.find((x) => x.id === id);
  if (!r) return [];
  if (oneOff(r) || !r.start) return [r];
  if (typeof r.series === 'number') {
    return routes.filter((o) => o.id === id || (!oneOff(o) && o.series === r.series)).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  }
  const cands = routes.filter((o) => o.id !== id && !oneOff(o) && !!o.start && o.type === r.type && o.code.toUpperCase() === r.code.toUpperCase());
  const out = [r];
  for (const forward of [false, true]) {
    let cur = r;
    for (;;) {
      const next = cands.find((o) =>
        !out.includes(o) && (forward ? !!cur.end && o.start === addDays(cur.end, 1) : !!o.end && addDays(o.end, 1) === cur.start),
      );
      if (!next) break;
      out.push(next);
      cur = next;
    }
  }
  return out.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

/** Usage::routeLive: the route still runs today or later. */
export function segmentLive(r: Segment, today: IsoDate): boolean {
  return oneOff(r) ? (r.date ?? '') >= today : !r.end || r.end >= today;
}

/** The segments an edit or a delete of route `id` reaches (Plan::liveChainOthers + itself): the live ones,
 *  or only `id` when it has already ended. Sorted by start. */
export function liveChain<T extends Segment>(routes: T[], id: number, today: IsoDate): T[] {
  const chain = routeChain(routes, id);
  const self = chain.find((x) => x.id === id);
  if (!self) return [];
  return segmentLive(self, today) ? chain.filter((x) => segmentLive(x, today)) : [self];
}

/** The route's real period: the server's route_start / route_end when given, else the first segment's
 *  start and the last one's end (null = open). */
export function chainPeriod(chain: Segment[]): { start: IsoDate | null; end: IsoDate | null } {
  if (!chain.length) return { start: null, end: null };
  const own = chain.find((s) => s.route_start !== undefined && s.route_end !== undefined);
  if (own) return { start: own.route_start ?? null, end: own.route_end ?? null };
  return { start: chain[0].start ?? null, end: chain[chain.length - 1].end ?? null };
}

/** The segment that runs on `date`: the last one starting on or before it (the first one when none does). */
export function segmentOn<T extends Segment>(chain: T[], date: IsoDate): T | undefined {
  let hit: T | undefined;
  for (const s of chain) if ((s.start ?? '') <= date) hit = s;
  return hit ?? chain[0];
}

/** The segment that an "end route from D" (end = D − 1) belongs to. When D is the first day of a later
 *  segment, that segment gets end = its start − 1 (it no longer runs), so the route stops after D − 1. */
export function endTarget<T extends Segment>(chain: T[], from: IsoDate): T | undefined {
  return segmentOn(chain, from);
}

/** "11 Nov – 19 Nov" / "from 20 Nov" for each segment, for the texts that name the parts of a split route. */
export function segmentPeriods(chain: Segment[], fmt: (d: IsoDate) => string, fromWord: (d: string) => string): string[] {
  return chain.map((s) => (s.end ? `${fmt(s.start ?? '')} – ${fmt(s.end)}` : fromWord(fmt(s.start ?? ''))));
}

/** Every route record (ended ones too), shared with the Routes page's "Show ended routes" list. */
export function useAllRoutes(enabled = true) {
  return useQuery({ queryKey: ['routes', { ended: true }], queryFn: () => listRoutes({ ended: true }), enabled, staleTime: 5_000 });
}
