// §13 StopList reordering: a drag end, ↑ ↓ and "move to #" produce the same draft order (arrayMove).
import { describe, expect, it } from 'vitest';
import {
  addStop,
  draftDiff,
  draftFrom,
  dropMove,
  isDirty,
  moveDown,
  moveToPosition,
  moveUp,
  removeStop,
  restoreStop,
  setStopDays,
  setStopNote,
  dayCounts,
} from './stopDraft';

const ids = (list: { customer_id: number }[]) => list.map((s) => s.customer_id);
const base = [10, 20, 30, 40, 50].map((id) => ({ customer_id: id, note: '' }));

describe('StopList reorder (one arrayMove for all three ways)', () => {
  it('drag 50 onto 20, three ↑, and "move to #2" give the same order', () => {
    const dragged = dropMove(base, '50', '20');
    let stepped = base;
    for (let i = 4; i > 1; i--) stepped = moveUp(stepped, i);
    const typed = moveToPosition(base, 4, 2);
    expect(ids(dragged)).toEqual([10, 50, 20, 30, 40]);
    expect(ids(stepped)).toEqual(ids(dragged));
    expect(ids(typed)).toEqual(ids(dragged));
  });

  it('drag down, ↓ and move to # agree too', () => {
    const dragged = dropMove(base, 10, 40);
    const stepped = moveDown(moveDown(moveDown(base, 0), 1), 2);
    const typed = moveToPosition(base, 0, 4);
    expect(ids(dragged)).toEqual([20, 30, 40, 10, 50]);
    expect(ids(stepped)).toEqual(ids(dragged));
    expect(ids(typed)).toEqual(ids(dragged));
  });

  it('clamps out-of-range moves and ignores no-ops', () => {
    expect(moveUp(base, 0)).toBe(base);
    expect(moveDown(base, 4)).toBe(base);
    expect(ids(moveToPosition(base, 1, 99))).toEqual([10, 30, 40, 50, 20]);
    expect(ids(moveToPosition(base, 3, 0))).toEqual([40, 10, 20, 30, 50]);
    expect(moveToPosition(base, 2, NaN)).toBe(base);
    expect(dropMove(base, '30', '30')).toBe(base);
    expect(dropMove(base, '30', null)).toBe(base);
    expect(dropMove(base, '99', '10')).toBe(base);
  });

  it('a 30-stop list: stop 28 typed to #2', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ customer_id: i + 1, note: '' }));
    const moved = moveToPosition(long, 27, 2);
    expect(ids(moved).slice(0, 3)).toEqual([1, 28, 2]);
    expect(moved).toHaveLength(30);
    expect(ids(dropMove(long, 28, 2))).toEqual(ids(moved));
  });
});

describe('draft edits', () => {
  it('add, remove, restore and notes; dirty and diff', () => {
    const saved = { stops: base.slice(0, 3), note: '' };
    let d = draftFrom(saved.stops, saved.note);
    expect(isDirty(d, saved)).toBe(false);
    d = addStop(d, 99);
    expect(ids(d.stops)).toEqual([10, 20, 30, 99]);
    expect(addStop(d, 99)).toBe(d); // never twice
    d = removeStop(d, 0);
    expect(ids(d.stops)).toEqual([20, 30, 99]);
    expect(ids(d.removed)).toEqual([10]);
    expect(draftDiff(saved.stops, d)).toEqual({ added: [99], removed: [10] });
    d = restoreStop(d, 10);
    expect(ids(d.stops)).toEqual([20, 30, 99, 10]);
    expect(d.removed).toEqual([]);
    d = setStopNote(d, 0, '3 bins');
    expect(d.stops[0]).toEqual({ customer_id: 20, note: '3 bins' });
    expect(isDirty(d, saved)).toBe(true);
    const back = draftFrom(saved.stops, 'x');
    expect(isDirty(back, saved)).toBe(true); // a note change alone makes it dirty
  });
});

describe('stop weekdays', () => {
  const route = [1, 3, 5];
  const saved = { stops: [{ customer_id: 10, note: '', days: [1, 5] }, { customer_id: 20, note: '' }], note: '' };
  it('the draft keeps them, and a weekday change alone makes it dirty', () => {
    const d = draftFrom(saved.stops, '');
    expect(d.stops).toEqual(saved.stops);
    expect(d.stops[0].days).not.toBe(saved.stops[0].days);
    expect(isDirty(d, saved)).toBe(false);
    expect(isDirty(setStopDays(d, 0, [1], route), saved)).toBe(true);
    expect(isDirty(setStopDays(d, 1, [1], route), saved)).toBe(true);
  });
  it('setStopDays: sorted, unique, inside the route days; every route day removes the key; none is ignored', () => {
    const d = draftFrom(saved.stops, '');
    const a = setStopDays(d, 1, [5, 1, 1, 2], route);
    expect(a.stops[1]).toEqual({ customer_id: 20, note: '', days: [1, 5] });
    expect(Object.keys(a.stops[1])).toEqual(['customer_id', 'note', 'days']);
    expect(a.stops[0]).toBe(d.stops[0]); // other stops untouched
    const all = setStopDays(d, 0, [5, 3, 1], route);
    expect(all.stops[0]).toEqual({ customer_id: 10, note: '' });
    expect('days' in all.stops[0]).toBe(false);
    expect(setStopDays(d, 0, [], route)).toBe(d);
    expect(setStopDays(d, 0, [2, 4], route)).toBe(d);
  });
  it('dayCounts: the stops collected on each route day', () => {
    expect(dayCounts(saved.stops, route)).toEqual([2, 1, 2]);
    expect(dayCounts([{ customer_id: 10, note: '', days: [1] }], route)).toEqual([1, 0, 0]);
  });
});
