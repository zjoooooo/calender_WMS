// What an edit of a split route does to its other parts (§6.5, Round 6), so the office can say it BEFORE the
// save. The server carries only the clerk's change into another part of the route (Plan::carry and
// Plan::mergeStops): weekdays (or Sunday / PH) added or removed, customers added, removed, moved or re-noted.
// What only that part has (a planned schedule change such as "Tue Thu from 21 Dec", customers added or
// removed from its start) is kept. This module mirrors those rules on the parts GET /api/routes/{id} returns:
// - carry, mergeStops: the server's rules, one to one;
// - afterPatch, afterSplit, afterFollowing: what PATCH /api/routes/{id}, POST …/change-schedule and
//   PUT …/dates/{D} with scope "following" leave in the parts (a part that a split creates has id 0);
// - keptSchedules, keptListsFollowing, keptListsTemplate: the parts whose own plan the clerk should hear
//   about, and keptScheduleText / keptListText: the notices of Edit route / schedule, the scope dialog and
//   the Routes page template editor.
// backend/tests/fixtures/split_carry_cases.json is checked against the server and against this module, so a
// notice says what the server then stores. The save sends the parts the notices were computed on (partsRev),
// and the server refuses it when one of them changed meanwhile, so a notice cannot go stale either.
import type { IsoDate, Lang, PartRev, RoutePart, Stop } from '../api';
import { fmtDay, weekdayList } from '../i18n/format';
import { addDays } from './calendarModel';

/** PHP trim(): the server trims a stop note (V::str) of these characters only. */
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

/** Plan::validateStops: [{customer_id, note}], the note trimmed. */
export function cleanStops(stops: readonly Stop[]): Stop[] {
  return stops.map((s) => ({ customer_id: Number(s.customer_id), note: phpTrim(s.note ?? '') }));
}

const sameList = (a: readonly Stop[], b: readonly Stop[]) => a.length === b.length && a.every((s, i) => s.customer_id === b[i].customer_id && s.note === b[i].note);
const sortedDays = (d: readonly number[]) => [...new Set(d)].sort((x, y) => x - y);

/** Plan::carry for weekdays: the days added (old → neu) join `t`, the removed ones leave it; a part left with
 *  no weekday takes the new ones. */
export function carryDays(t: readonly number[], old: readonly number[], neu: readonly number[]): number[] {
  if (old.join() === neu.join()) return [...t];
  const add = neu.filter((d) => !old.includes(d));
  const rem = old.filter((d) => !neu.includes(d));
  const days = sortedDays([...t, ...add]).filter((d) => !rem.includes(d));
  return days.length ? days : [...neu];
}

type SunPh = { sun: boolean | null; ph: boolean | null };

/** Plan::carry for a special route: Sunday or PH, when the edit changed it, takes its new value; a part left
 *  with neither takes the new choice. */
export function carrySunPh(t: SunPh, old: SunPh, neu: SunPh): { sun: boolean; ph: boolean } {
  const sun = !!neu.sun !== !!old.sun ? !!neu.sun : !!t.sun;
  const ph = !!neu.ph !== !!old.ph ? !!neu.ph : !!t.ph;
  return sun || ph ? { sun, ph } : { sun: !!neu.sun, ph: !!neu.ph };
}

/**
 * Plan::mergeStops: list `seg` with the change from `old` to `neu`. A list equal to `old` becomes `neu`.
 * Otherwise removed customers leave; changed stop notes follow; customers in both lists that were moved take
 * the new order in the places they hold in `seg`; an added customer goes before the nearest customer after it
 * in `neu` that `seg` has (else at the end), unless `seg` already has it.
 */
export function mergeStops(old: readonly Stop[], neu: readonly Stop[], seg: readonly Stop[]): Stop[] {
  if (sameList(seg, old)) return neu.map((s) => ({ ...s }));
  const oldIds = old.map((s) => s.customer_id);
  const newIds = neu.map((s) => s.customer_id);
  const oldNote = new Map(old.map((s) => [s.customer_id, s.note]));
  const newNote = new Map(neu.map((s) => [s.customer_id, s.note]));
  const out: Stop[] = [];
  for (const s of seg) {
    const cid = s.customer_id;
    if (oldIds.includes(cid) && !newIds.includes(cid)) continue;
    const changed = oldNote.has(cid) && newNote.has(cid) && oldNote.get(cid) !== newNote.get(cid);
    out.push(changed ? { ...s, note: newNote.get(cid) ?? '' } : { ...s });
  }
  const after = newIds.filter((c) => oldIds.includes(c));
  if (oldIds.filter((c) => newIds.includes(c)).join() !== after.join()) {
    const slots: number[] = [];
    const byId = new Map<number, Stop>();
    out.forEach((s, p) => {
      if (after.includes(s.customer_id)) {
        slots.push(p);
        byId.set(s.customer_id, s);
      }
    });
    const order = after.filter((c) => byId.has(c));
    slots.forEach((p, n) => (out[p] = byId.get(order[n])!));
  }
  neu.forEach((s, pos) => {
    const have = out.map((x) => x.customer_id);
    if (oldIds.includes(s.customer_id) || have.includes(s.customer_id)) return;
    let at = out.length;
    for (let q = pos + 1; q < neu.length; q++) {
      const p = have.indexOf(neu[q].customer_id);
      if (p !== -1) {
        at = p;
        break;
      }
    }
    out.splice(at, 0, { ...s });
  });
  return out;
}

/** Plan::carry: the change a record went through (old → neu) carried into another part `t` of the route:
 *  weekdays or Sunday / PH and, with `stops`, the customer list. */
export function carry(t: RoutePart, old: RoutePart, neu: RoutePart, stops: boolean): RoutePart {
  const out: RoutePart = { ...t };
  if (neu.days) out.days = carryDays(t.days ?? [], old.days ?? [], neu.days);
  else Object.assign(out, carrySunPh(t, old, neu));
  if (stops && !sameList(neu.stops, old.stops)) out.stops = mergeStops(old.stops, neu.stops, t.stops);
  return out;
}

type SchedFields = { days?: number[]; sun?: boolean | null; ph?: boolean | null };
export type PartsPatch = SchedFields & { start?: IsoDate; end?: IsoDate | null; stops?: Stop[] };
export type PartsSchedule = SchedFields & { from: IsoDate; end?: IsoDate | null; stops?: Stop[] | null };

/** Plan::applyRecurring for the schedule fields sent; null when the server refuses the schedule (no weekday,
 *  or neither Sunday nor PH), so nothing is predicted while the form has none. */
function withSched(p: RoutePart, b: SchedFields): RoutePart | null {
  const r: RoutePart = { ...p };
  if (p.days) {
    if (b.days !== undefined) r.days = sortedDays(b.days);
    return r.days?.length ? r : null;
  }
  if (b.sun !== undefined) r.sun = !!b.sun;
  if (b.ph !== undefined) r.ph = !!b.ph;
  return r.sun || r.ph ? r : null;
}

/** Plan::setChainEnd on parts sorted by start: the last part that starts on or before the end gets it, the
 *  later ones (not started yet) are removed; null removes the end. */
function withEnd(parts: RoutePart[], end: IsoDate | null): RoutePart[] {
  const keep = parts.filter((p, n) => n === 0 || end === null || p.start <= end);
  return keep.map((p, n) => (n === keep.length - 1 ? { ...p, end } : p));
}

/** The part that runs on `d`: the last one starting on or before it. */
function partOn<T extends { start: IsoDate }>(parts: readonly T[], d: IsoDate): T | undefined {
  let hit: T | undefined;
  for (const p of parts) if (p.start <= d) hit = p;
  return hit;
}

/**
 * PATCH /api/routes/{id} on a live record (Plan::patchRoute): weekdays or Sunday / PH and the template list
 * change on that record and are carried into every other part; a new start is the route's start (the first
 * part's, setChainStart) and a new end the route's end. Code, colour, name and note do not change what a part
 * runs or lists, so they are not mirrored. null when the server refuses the schedule (withSched).
 */
export function afterPatch(parts: readonly RoutePart[], id: number, body: PartsPatch): RoutePart[] | null {
  const old = parts.find((p) => p.id === id);
  if (!old) return [...parts];
  const r = withSched(old, body);
  if (!r) return null;
  if (body.stops !== undefined) r.stops = cleanStops(body.stops);
  if (parts.length === 1 && body.end !== undefined) r.end = body.end;
  const out = parts.map((p) => (p.id === id ? r : carry(p, old, r, body.stops !== undefined)));
  if (body.start !== undefined) out[0] = { ...out[0], start: body.start };
  return parts.length > 1 && body.end !== undefined ? withEnd(out, body.end) : out;
}

/**
 * POST /api/routes/{id}/change-schedule (Plan::split, R14): the part that runs on `from` ends the day before
 * and continues from `from` with the schedule (and list) sent, or takes them when `from` is its first day;
 * the later parts get the same change (carry). null when the server refuses the date (today or earlier, not
 * after the route's start, after its end, or an end before `from`) or the schedule (withSched).
 */
export function afterSplit(parts: readonly RoutePart[], body: PartsSchedule, today: IsoDate): RoutePart[] | null {
  const { from } = body;
  if (!parts.length || from <= today || from <= parts[0].start) return null;
  const seg = partOn(parts, from)!;
  const n = parts.indexOf(seg);
  if (seg.end !== null && from > seg.end) return null;
  const created = withSched(from === seg.start ? seg : { ...seg, id: 0, start: from }, body);
  if (!created) return null;
  if (body.stops !== undefined && body.stops !== null) created.stops = cleanStops(body.stops);
  const later = new Set(parts.slice(n + 1).map((p) => p.id));
  let out = (from === seg.start ? parts.map((p, k) => (k === n ? created : p)) : [...parts.slice(0, n), { ...seg, end: addDays(from, -1) }, created, ...parts.slice(n + 1)]).map(
    (p) => (later.has(p.id) ? carry(p, seg, created, true) : p),
  );
  if (body.end !== undefined && body.end !== parts[parts.length - 1].end) {
    if (body.end !== null && body.end < from) return null;
    out = withEnd(out, body.end);
  }
  return out;
}

/**
 * PUT /api/routes/{id}/dates/{D} with scope "following" and a list (R12): record `id`, the one that runs on D,
 * has that list from D (a template replace or a split, Plan::putRouteDate) and every later part gets the change
 * from that record's own list (carry). Returns those later parts, as the save leaves them.
 */
export function afterFollowing(parts: readonly RoutePart[], id: number, stops: readonly Stop[]): RoutePart[] {
  const k = parts.findIndex((p) => p.id === id);
  if (k < 0) return [];
  const seg = parts[k];
  const neu: RoutePart = { ...seg, stops: cleanStops(stops) };
  return parts.slice(k + 1).map((p) => carry(p, seg, neu, true));
}

/** The parts a screen computed its notices on, as the save sends them (`parts`): the server refuses the save
 *  (409 STALE_REVISION) when another clerk changed one of them meanwhile. Undefined when there is nothing to send. */
export function partsRev(parts: readonly RoutePart[] | null | undefined): PartRev[] | undefined {
  return parts?.length && parts.every((p) => typeof p.rev === 'number') ? parts.map((p) => ({ id: p.id, rev: p.rev! })) : undefined;
}

// ---- what the clerk is told before the save ---------------------------------------------------------------

type Sched = Pick<RoutePart, 'days' | 'sun' | 'ph'>;
const sameSched = (a: Sched, b: Sched) => (a.days ?? []).join() === (b.days ?? []).join() && !!a.sun === !!b.sun && !!a.ph === !!b.ph;

export interface KeptSchedule {
  /** The part as it is now, and as the save leaves it. */
  part: RoutePart;
  after: RoutePart;
  /** "Apply from" a date inside this part, which is not the part the form shows and has a schedule of its own:
   *  from that date the form's schedule replaces it (`after` is the part that runs from that date). */
  replacedFrom?: IsoDate;
  /** The change reaches this part measured from another schedule than the form's own (that of the part that
   *  runs on `date`, `old`, which becomes `neu`), so it is not just the weekdays the clerk added or removed. */
  via?: { date: IsoDate; old: Sched; neu: Sched };
}

/**
 * Edit route / schedule (§6.5): the other parts that have a schedule of their own, and what each runs after
 * the save (`after`: afterPatch / afterSplit of the form's writes; null = the save is refused). From today
 * (`from` null) the change is the opened record's and reaches every other part; from D it is the change of
 * the part that runs on D and reaches the parts after D. A part with the same schedule as the one the change
 * starts from simply takes the new one and is not listed, nor is a part that the new end removes.
 */
export function keptSchedules(parts: readonly RoutePart[], after: readonly RoutePart[] | null, openedId: number, from: IsoDate | null): KeptSchedule[] {
  const opened = parts.find((p) => p.id === openedId);
  const base = from === null ? opened : partOn(parts, from);
  if (!after || !opened || !base) return [];
  const out: KeptSchedule[] = [];
  const now = from === null ? undefined : partOn(after, from);
  if (from !== null && now && base.id !== opened.id && !sameSched(base, opened) && !sameSched(base, now)) out.push({ part: base, after: now, replacedFrom: from });
  const via = from !== null && now && !sameSched(base, opened) ? { via: { date: from, old: base, neu: now } } : {};
  for (const p of parts) {
    if (p.id === base.id || (from !== null && p.start <= from)) continue;
    const a = after.find((x) => x.id === p.id);
    if (a && !sameSched(p, base)) out.push({ part: p, after: a, ...via });
  }
  return out;
}

export interface KeptList {
  /** The part as it is now, and as the save leaves it. */
  part: RoutePart;
  after: RoutePart;
  /** Customers it has that the saved list does not (its order), and customers of the saved list it does not
   *  have (the list's order): its list after the save, or with `replacedFrom` its own list now. */
  also: number[];
  lacks: number[];
  /** The template editor "from D" with D inside this part, which is not the opened one and has a list of its own
   *  (other customers than the opened part's): from D the saved list replaces it. */
  replacedFrom?: IsoDate;
}

const sameMembers = (a: readonly Stop[], b: readonly Stop[]) => a.length === b.length && a.every((s) => b.some((x) => x.customer_id === s.customer_id));

function listDiff(have: readonly Stop[], saved: readonly Stop[]): { also: number[]; lacks: number[] } {
  const s = new Set(saved.map((x) => x.customer_id));
  const h = new Set(have.map((x) => x.customer_id));
  return { also: have.filter((x) => !s.has(x.customer_id)).map((x) => x.customer_id), lacks: saved.filter((x) => !h.has(x.customer_id)).map((x) => x.customer_id) };
}

function keptOf(part: RoutePart, after: RoutePart, have: readonly Stop[], saved: readonly Stop[], replacedFrom?: IsoDate): KeptList[] {
  const d = listDiff(have, saved);
  return d.also.length || d.lacks.length ? [{ part, after, ...d, ...(replacedFrom ? { replacedFrom } : {}) }] : [];
}

/** The scope dialog's "this date and all following" on record `id` (afterFollowing): the later parts whose
 *  list after the save has other customers than the saved list (an order of their own is not listed). */
export function keptListsFollowing(parts: readonly RoutePart[], id: number, stops: readonly Stop[]): KeptList[] {
  const k = parts.findIndex((p) => p.id === id);
  return afterFollowing(parts, id, stops).flatMap((a, j) => keptOf(parts[k + 1 + j], a, a.stops, stops));
}

/**
 * The Routes page template editor (opened on record `openedId`): from today (`from` null, PATCH stops) every
 * other part; from D (change-schedule with the list) the parts after D, and the part that runs on D when it is
 * not the opened one and has customers of its own (from D the saved list replaces its list). Listed: the parts
 * whose customers differ from the saved list.
 */
export function keptListsTemplate(parts: readonly RoutePart[], openedId: number, stops: readonly Stop[], from: IsoDate | null, today: IsoDate): KeptList[] {
  if (from === null) {
    const after = afterPatch(parts, openedId, { stops: [...stops] }) ?? [];
    return parts.flatMap((p) => {
      const a = after.find((x) => x.id === p.id);
      return p.id !== openedId && a ? keptOf(p, a, a.stops, stops) : [];
    });
  }
  const after = afterSplit(parts, { from, stops: [...stops] }, today);
  const base = partOn(parts, from);
  const opened = parts.find((p) => p.id === openedId);
  if (!after || !base || !opened) return [];
  const now = partOn(after, from)!;
  const out = base.id !== openedId && !sameMembers(base.stops, opened.stops) ? keptOf(base, now, base.stops, stops, from) : [];
  for (const p of parts) {
    const a = after.find((x) => x.id === p.id);
    if (p.start > from && a) out.push(...keptOf(p, a, a.stops, stops));
  }
  return out;
}

// ---- texts ------------------------------------------------------------------------------------------------

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "Mon 21 Dec" / "12月21日" (the Chinese texts read "12月21日起", without the weekday). */
const day = (d: IsoDate, lang: Lang) => fmtDay(d, lang, { weekday: lang !== 'zh' });

/** "from Mon 21 Dec", "from Wed 2 Dec to Sun 20 Dec", or "until Tue 1 Dec" for a part that already runs. */
export function partWhen(p: { start: IsoDate; end: IsoDate | null }, today: IsoDate, t: T, lang: Lang): string {
  if (p.end && p.start <= today) return t('kept.until', { date: day(p.end, lang) });
  if (p.end) return t('kept.fromTo', { from: day(p.start, lang), to: day(p.end, lang) });
  return t('kept.from', { date: day(p.start, lang) });
}

/** "Tue Thu" / "every Sunday + every PH". */
function schedText(s: Sched, t: T, lang: Lang): string {
  return s.days ? weekdayList(s.days, lang) : [s.sun ? t('rule.everySun') : '', s.ph ? t('rule.everyPh') : ''].filter(Boolean).join(' + ');
}

/** "Already planned: from Mon 21 Dec this route runs Tue Thu. That plan is kept; …, so from Mon 21 Dec it runs Tue Thu Sat."
 *  With `via` the change is named as the server measures it: "This change, Tue Thu to Mon Wed Fri Sat from …". */
export function keptScheduleText(k: KeptSchedule, today: IsoDate, t: T, lang: Lang): string {
  const vars = { when: partWhen(k.part, today, t, lang), days: schedText(k.part, t, lang), after: partWhen(k.after, today, t, lang), result: schedText(k.after, t, lang) };
  if (k.replacedFrom) return t('kept.daysReplaced', { ...vars, date: day(k.replacedFrom, lang) });
  if (sameSched(k.part, k.after)) return t('kept.days', vars);
  if (k.via) return t('kept.changeCarried', { ...vars, date: day(k.via.date, lang), old: schedText(k.via.old, t, lang), neu: schedText(k.via.neu, t, lang) });
  return t(k.part.days ? 'kept.daysCarried' : 'kept.sunPhCarried', vars);
}

/** "Already planned from Wed 2 Dec: that part keeps its own list. It also has Lim Trading and does not have Tan Hardware." */
export function keptListText(k: KeptList, today: IsoDate, t: T, lang: Lang, nameOf: (id: number) => string): string {
  const names = (ids: number[]) => ids.map(nameOf).join(lang === 'zh' ? '、' : ', ');
  const when = partWhen(k.part, today, t, lang);
  const diff =
    k.also.length && k.lacks.length
      ? t('kept.listBoth', { also: names(k.also), lacks: names(k.lacks) })
      : k.also.length
        ? t('kept.listAlso', { also: names(k.also) })
        : t('kept.listLacks', { lacks: names(k.lacks) });
  if (k.replacedFrom) return [t('kept.listOwn', { when }), diff, t('kept.listReplacedFrom', { date: day(k.replacedFrom, lang) })].join(lang === 'zh' ? '' : ' ');
  return [t('kept.list', { when }), diff].join(lang === 'zh' ? '' : ' ');
}
