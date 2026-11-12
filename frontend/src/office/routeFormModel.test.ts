// Edit route / schedule on a split route (K3, SPLIT-UI-04/05) and concurrent edits (K4, SPLIT-UI-11).
import { describe, expect, it } from 'vitest';
import type { RouteDetail } from '../api';
import { afterStep, mergeServer, planEdit, snapOf, type FormVals } from './routeFormModel';
import type { Segment } from './routeChain';

const TODAY = '2026-11-11';
const detail = (id: number, start: string, end: string | null, extra: Partial<RouteDetail> = {}): RouteDetail => ({
  id,
  code: 'E2',
  color: 4,
  type: 'regular',
  name: 'East 2 · Bedok',
  note: '',
  rev: 1,
  recurring: true,
  date: null,
  start,
  end,
  days: [1, 3, 5],
  sun: null,
  ph: null,
  stops: [],
  overrides: [],
  ...extra,
});
const item = (r: RouteDetail): Segment => ({ ...r });

// E2 split at Fri 20 Nov: #5 11–19 Nov, #22 from 20 Nov.
const A = detail(5, '2026-11-11', '2026-11-19', { rev: 2 });
const B = detail(22, '2026-11-20', null);
const all = [item(A), item(B), item(detail(13, '2026-11-11', null, { code: 'K1' }))];

describe('snapOf: the whole route', () => {
  it('opened from the later part: Start is the route start (K3)', () => {
    const s = snapOf(B, all, TODAY);
    expect(s.vals.start).toBe('2026-11-11');
    expect(s.vals.end).toBe('');
    expect(s.segs.map((x) => x.id)).toEqual([5, 22]);
  });
  it('opened from the earlier part: End is empty, not the split boundary (SPLIT-UI-05)', () => {
    const s = snapOf(A, all, TODAY);
    expect(s.vals.start).toBe('2026-11-11');
    expect(s.vals.end).toBe('');
  });
  it('without the route list (it failed): the segment alone', () => {
    expect(snapOf(B, undefined, TODAY).vals.start).toBe('2026-11-20');
  });
  it('an ended segment is edited alone, with its own period', () => {
    const s = snapOf(A, all, '2026-11-25');
    expect([s.vals.start, s.vals.end, s.segs.length]).toEqual(['2026-11-11', '2026-11-19', 1]);
  });
});

describe('planEdit', () => {
  const opts = { type: 'regular' as const, oneOff: false, apply: 'today' as const, fromDate: '' };
  it('nothing changed: no write (saving an untouched End on the earlier part is harmless)', () => {
    const base = snapOf(A, all, TODAY);
    expect(planEdit(base.vals, base, opts)).toEqual([]);
  });
  it('only the touched fields are sent, to the opened part, with the loaded rev', () => {
    const base = snapOf(B, all, TODAY);
    const steps = planEdit({ ...base.vals, note: 'clerk 1 note' }, base, opts);
    expect(steps).toEqual([{ kind: 'patch', id: 22, body: { rev: 1, note: 'clerk 1 note' } }]);
  });
  it('an End inside the earlier part goes to that part (opened from the later one)', () => {
    const base = snapOf(B, all, TODAY);
    const steps = planEdit({ ...base.vals, end: '2026-11-15' }, base, opts);
    expect(steps).toEqual([{ kind: 'patch', id: 5, body: { rev: 2, end: '2026-11-15' } }]);
  });
  it('an End after the split goes to the last part (opened from the earlier one)', () => {
    const base = snapOf(A, all, TODAY);
    const steps = planEdit({ ...base.vals, end: '2026-12-31' }, base, opts);
    expect(steps).toEqual([{ kind: 'patch', id: 22, body: { rev: 1, end: '2026-12-31' } }]);
  });
  it('a later Start goes to the first part, before the edit of the opened one', () => {
    const base = snapOf(B, all, TODAY);
    const steps = planEdit({ ...base.vals, start: '2026-11-13', name: 'East 2' }, base, opts);
    expect(steps).toEqual([
      { kind: 'patch', id: 5, body: { rev: 2, start: '2026-11-13' } },
      { kind: 'patch', id: 22, body: { rev: 1, name: 'East 2' } },
    ]);
  });
  it('weekdays changed with the End in another part: that part gets the same change on its own weekdays', () => {
    const b2 = detail(22, '2026-11-20', null, { days: [1, 3] });
    const base = snapOf(b2, [item(A), item(b2)], TODAY);
    const steps = planEdit({ ...base.vals, days: [1], end: '2026-11-17' }, base, opts);
    expect(steps).toEqual([{ kind: 'patch', id: 5, body: { rev: 2, days: [1, 5], end: '2026-11-17' } }]);
  });
  it('From date D in the later part: the schedule change goes to that part; End is sent only when changed', () => {
    const base = snapOf(A, all, TODAY);
    const steps = planEdit({ ...base.vals, days: [1, 3] }, base, { ...opts, apply: 'from', fromDate: '2026-11-25' });
    expect(steps).toEqual([{ kind: 'schedule', id: 22, body: { rev: 1, from: '2026-11-25', days: [1, 3] } }]);
  });
  it('a one-off sends only a changed date', () => {
    const one = detail(40, '', null, { recurring: false, date: '2026-11-12', start: null, type: 'adhoc', days: null });
    const base = snapOf(one, all, TODAY);
    expect(planEdit({ ...base.vals, date: '2026-11-13' }, base, { ...opts, type: 'adhoc', oneOff: true })).toEqual([
      { kind: 'patch', id: 40, body: { rev: 1, date: '2026-11-13' } },
    ]);
  });
});

describe('mergeServer: someone else saved meanwhile (SPLIT-UI-11)', () => {
  const base = snapOf(B, all, TODAY);
  const mine: FormVals = { ...base.vals, note: 'clerk 1 note' };
  const theirs = snapOf({ ...B, rev: 2, name: 'East 2 · by clerk 2' }, all, TODAY);

  it('while editing: untouched fields take their values, the loaded rev is kept (Save is refused once)', () => {
    const m = mergeServer(mine, base, theirs, false);
    expect(m.vals.name).toBe('East 2 · by clerk 2');
    expect(m.vals.note).toBe('clerk 1 note');
    expect(m.theirs).toEqual(['name']);
    expect(m.base.rev).toBe(1);
    // The refused Save would have sent only the note.
    expect(planEdit(m.vals, m.base, { type: 'regular', oneOff: false, apply: 'today', fromDate: '' })).toEqual([
      { kind: 'patch', id: 22, body: { rev: 1, note: 'clerk 1 note' } },
    ]);
  });
  it('after STALE_REVISION: their version is the base; the second Save sends only the note with their rev', () => {
    const m = mergeServer(mine, base, theirs, true);
    expect(m.base.rev).toBe(2);
    expect(planEdit(m.vals, m.base, { type: 'regular', oneOff: false, apply: 'today', fromDate: '' })).toEqual([
      { kind: 'patch', id: 22, body: { rev: 2, note: 'clerk 1 note' } },
    ]);
  });
  it('the same field changed by both: the clerk keeps their own value (the second Save replaces on purpose)', () => {
    const m = mergeServer({ ...base.vals, name: 'mine' }, base, theirs, true);
    expect(m.vals.name).toBe('mine');
    expect(m.theirs).toEqual(['name']);
  });
  it('a clean form follows the server completely', () => {
    const m = mergeServer(base.vals, base, theirs, false);
    expect(m.vals.name).toBe('East 2 · by clerk 2');
    expect(m.base.rev).toBe(2);
  });
  it('a server value equal to the clerk\'s own is not reported as theirs', () => {
    const m = mergeServer({ ...base.vals, name: 'East 2 · by clerk 2' }, base, theirs, false);
    expect(m.theirs).toEqual([]);
  });
  it('afterStep: a write that went through becomes the base', () => {
    const step = planEdit(mine, base, { type: 'regular', oneOff: false, apply: 'today', fromDate: '' })[0];
    const nb = afterStep(base, mine, step, 5);
    expect([nb.rev, nb.vals.note]).toEqual([5, 'clerk 1 note']);
  });
});

describe('planEdit with a server that links the parts (series)', () => {
  const La = detail(5, '2026-11-11', '2026-11-19', { rev: 2, series: 5, route_start: '2026-11-11', route_end: null });
  const Lb = detail(22, '2026-11-20', null, { days: [1, 3], series: 5, route_start: '2026-11-11', route_end: null });
  const lAll = [item(La), item(Lb)];
  const opts = { type: 'regular' as const, oneOff: false, apply: 'today' as const, fromDate: '' };
  it('shows the server period and sends one PATCH to the opened record (the server applies it to the route)', () => {
    const base = snapOf(Lb, lAll, TODAY);
    expect([base.linked, base.vals.start, base.vals.end]).toEqual([true, '2026-11-11', '']);
    expect(planEdit({ ...base.vals, days: [1, 3, 5], end: '2026-11-17', name: 'East 2' }, base, opts)).toEqual([
      { kind: 'patch', id: 22, body: { rev: 1, name: 'East 2', days: [1, 3, 5], end: '2026-11-17' } },
    ]);
  });
  it('From date D in another part: the schedule change goes to the opened record', () => {
    const base = snapOf(La, lAll, TODAY);
    expect(planEdit({ ...base.vals, days: [1] }, base, { ...opts, apply: 'from', fromDate: '2026-11-25' })).toEqual([
      { kind: 'schedule', id: 5, body: { rev: 2, from: '2026-11-25', days: [1] } },
    ]);
  });
});
