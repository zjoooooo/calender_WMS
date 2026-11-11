// The Edit route / schedule form's model (§6.5), kept free of React so it can be unit-tested.
// - snapOf: the version of the route the form shows. For a split route (R12 / R14) that is the whole route:
//   Start is the first segment's start and End the last one's end (K3, SPLIT-UI-05), not the period of
//   the segment the form was opened from.
// - mergeServer: R20 without lost updates (K4, SPLIT-UI-11). The form keeps the version it was loaded from
//   (`base`). When the server's version changes, every field the clerk did not touch takes the server's
//   value; touched fields keep the clerk's value. While the form is dirty its rev stays the loaded one, so
//   the first Save is answered with STALE_REVISION; after that answer the base is the server's version.
// - planEdit: the writes for a save. Only the fields that differ from the base are sent. A server that links
//   the parts of a split route (`series` in its payload) applies every field of an edit to the whole route,
//   whichever part it is sent to: one PATCH to the opened record. Otherwise code, colour, name, note and
//   weekdays go to the opened segment (the server carries them to the other live segments), a changed end
//   to the segment that runs on that date and a changed start to the first live segment, so a split route is
//   still ended or started as one route.
import type { ChangeScheduleBody, IsoDate, RouteDetail, RoutePatch, RouteType } from '../api';
import { addDays } from './calendarModel';
import { chainPeriod, endTarget, routeChain, segmentLive, segmentOn, type Segment } from './routeChain';

export interface FormVals {
  code: string;
  color: number | null;
  name: string;
  note: string;
  days: number[];
  sun: boolean;
  ph: boolean;
  start: IsoDate | '';
  end: IsoDate | '';
  date: IsoDate | '';
}
export type Field = keyof FormVals;
export const FIELDS: Field[] = ['code', 'color', 'name', 'note', 'days', 'sun', 'ph', 'start', 'end', 'date'];

/** A loaded version: the opened route's id and rev, the form values, and the live segments (sorted). */
export interface Snap {
  id: number;
  rev: number;
  vals: FormVals;
  segs: Segment[];
  /** The server links the parts (`series`) and applies an edit of any part to the whole route. */
  linked?: boolean;
}

export function snapOf(route: RouteDetail, all: Segment[] | undefined, today: IsoDate): Snap {
  const self: Segment = route;
  const oneOff = !route.recurring && !!route.date;
  let chain: Segment[] = [self];
  if (!oneOff && all && segmentLive(self, today)) {
    // The detail is fresher than the list for the opened route itself.
    const list = all.some((x) => x.id === route.id) ? all.map((x) => (x.id === route.id ? self : x)) : [...all, self];
    chain = routeChain(list, route.id);
  }
  const { start, end } = oneOff ? { start: null, end: null } : chainPeriod(chain);
  return {
    id: route.id,
    rev: route.rev,
    linked: typeof route.series === 'number',
    segs: chain.filter((s) => s.id === route.id || segmentLive(s, today)),
    vals: {
      code: route.code,
      color: route.color,
      name: route.name,
      note: route.note,
      days: sortedDays(route.days ?? []),
      sun: !!route.sun,
      ph: !!route.ph,
      start: start ?? '',
      end: end ?? '',
      date: route.date ?? '',
    },
  };
}

const sortedDays = (d: number[]) => [...new Set(d)].sort((a, b) => a - b);

export function sameVal<K extends Field>(k: K, a: FormVals[K], b: FormVals[K]): boolean {
  if (k === 'days') return sortedDays(a as number[]).join() === sortedDays(b as number[]).join();
  if (k === 'code') return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
  if (k === 'name' || k === 'note') return String(a).trim() === String(b).trim();
  return a === b;
}

/** The fields whose values differ. */
export function changedFields(a: FormVals, b: FormVals): Field[] {
  return FIELDS.filter((k) => !sameVal(k, a[k], b[k]));
}

/**
 * A new server version arrived. Untouched fields take its values. `theirs` lists the fields the server
 * changed. A clean form follows the server completely; a dirty one keeps its rev (so its Save is refused
 * once, R20) unless `afterStale` (the STALE_REVISION answer: the next Save replaces on purpose).
 */
export function mergeServer(vals: FormVals, base: Snap, server: Snap, afterStale: boolean): { vals: FormVals; base: Snap; theirs: Field[] } {
  const touched = changedFields(vals, base.vals);
  // Changed on the server, and not to the value the clerk has (e.g. the clerk's own earlier write).
  const theirs = changedFields(server.vals, base.vals).filter((k) => !sameVal(k, server.vals[k], vals[k]));
  const next = { ...vals } as Record<Field, unknown>;
  const nb = { ...base.vals } as Record<Field, unknown>;
  for (const k of FIELDS) {
    if (!touched.includes(k)) {
      next[k] = server.vals[k];
      nb[k] = server.vals[k];
    }
  }
  const keep = touched.length > 0 && !afterStale;
  return { vals: next as unknown as FormVals, base: keep ? { ...base, vals: nb as unknown as FormVals } : server, theirs };
}

export type Step = { kind: 'patch'; id: number; body: RoutePatch } | { kind: 'schedule'; id: number; body: ChangeScheduleBody };

/** Weekdays added and removed in the form, applied to another segment's own weekdays (as the server does). */
function withDelta(segDays: number[], baseDays: number[], newDays: number[]): number[] {
  const add = newDays.filter((d) => !baseDays.includes(d));
  const rem = baseDays.filter((d) => !newDays.includes(d));
  const out = sortedDays([...segDays, ...add]).filter((d) => !rem.includes(d));
  return out.length ? out : sortedDays(newDays);
}

/** The writes for an edit save (in order). An empty list: nothing changed. */
export function planEdit(vals: FormVals, base: Snap, opts: { type: RouteType; oneOff: boolean; apply: 'today' | 'from'; fromDate: IsoDate }): Step[] {
  const b = base.vals;
  const ch = (k: Field) => !sameVal(k, vals[k], b[k]);
  const ident: Omit<RoutePatch, 'rev'> = {};
  if (ch('code')) ident.code = vals.code.trim().toUpperCase();
  if (ch('color') && vals.color !== null) ident.color = vals.color;
  if (ch('name')) ident.name = vals.name.trim();
  if (ch('note')) ident.note = vals.note.trim();
  const segs = base.segs.length ? base.segs : [{ id: base.id, code: b.code, type: opts.type, rev: base.rev, days: b.days }];
  const revOf = (id: number) => (id === base.id ? base.rev : (segs.find((s) => s.id === id)?.rev ?? base.rev));

  if (opts.oneOff) {
    if (ch('date')) ident.date = vals.date;
    return Object.keys(ident).length ? [{ kind: 'patch', id: base.id, body: { rev: base.rev, ...ident } }] : [];
  }
  const steps: Step[] = [];
  const sched = (): Pick<RoutePatch, 'days' | 'sun' | 'ph'> => {
    const x: Pick<RoutePatch, 'days' | 'sun' | 'ph'> = {};
    if (opts.type === 'regular' && ch('days')) x.days = sortedDays(vals.days);
    if (opts.type !== 'regular') {
      if (ch('sun')) x.sun = vals.sun;
      if (ch('ph')) x.ph = vals.ph;
    }
    return x;
  };
  if (opts.apply === 'today' && base.linked) {
    const body: RoutePatch = { rev: base.rev, ...ident, ...sched() };
    if (ch('end')) body.end = vals.end || null;
    if (ch('start')) body.start = vals.start;
    return Object.keys(body).length > 1 ? [{ kind: 'patch', id: base.id, body }] : [];
  }
  if (opts.apply === 'today') {
    const opened = segs.find((s) => s.id === base.id) ?? segs[0];
    const target = ch('end') ? (vals.end ? endTarget(segs, addDays(vals.end, 1)) : segs[segs.length - 1]) ?? opened : opened;
    const first = segs[0];
    const body: RoutePatch = { rev: revOf(target.id), ...ident };
    if (opts.type === 'regular' && ch('days')) body.days = target.id === base.id ? sortedDays(vals.days) : withDelta(target.days ?? b.days, b.days, vals.days);
    if (opts.type !== 'regular') {
      if (ch('sun')) body.sun = vals.sun;
      if (ch('ph')) body.ph = vals.ph;
    }
    if (ch('end')) body.end = vals.end || null;
    if (ch('start')) {
      if (first.id === target.id) body.start = vals.start;
      else steps.push({ kind: 'patch', id: first.id, body: { rev: revOf(first.id), start: vals.start } });
    }
    if (Object.keys(body).length > 1) steps.push({ kind: 'patch', id: target.id, body });
    return steps;
  }
  // From date D: identity first (a template edit), then the schedule split (R14) of the segment that runs on D
  // (a linking server finds that segment itself).
  const target = base.linked ? (segs.find((s) => s.id === base.id) ?? segs[0]) : (segmentOn(segs, opts.fromDate) ?? segs[0]);
  if (Object.keys(ident).length) steps.push({ kind: 'patch', id: target.id, body: { rev: revOf(target.id), ...ident } });
  const next = opts.type === 'regular' ? { days: sortedDays(vals.days) } : { sun: vals.sun, ph: vals.ph };
  steps.push({ kind: 'schedule', id: target.id, body: { rev: revOf(target.id), from: opts.fromDate, ...next, ...(ch('end') ? { end: vals.end || null } : {}) } });
  return steps;
}

/** One write of a save went through: what it sent is now the base (a retry or a second Save does not resend
 *  it), with the segment's new rev. */
export function afterStep(base: Snap, vals: FormVals, step: Step, rev: number): Snap {
  const nv = { ...base.vals } as Record<Field, unknown>;
  if (step.kind === 'patch') for (const k of FIELDS) if (k in step.body) nv[k] = vals[k];
  return {
    ...base,
    rev: step.id === base.id ? rev : base.rev,
    vals: nv as unknown as FormVals,
    segs: base.segs.map((s) => (s.id === step.id ? { ...s, rev } : s)),
  };
}
