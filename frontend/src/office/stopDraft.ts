// The route drawer's local draft (§6.1): the stop list being edited, the stops removed from it and the
// occurrence note. Pure functions only, so the three reorder ways (drag and drop, ↑ ↓, "move to #") are
// provably the same `arrayMove` (§13 StopList test). Nothing here talks to the server.
import { arrayMove } from '@dnd-kit/sortable';
import type { Stop } from '../api';

export interface Draft {
  /** Visit order; seq = index + 1. */
  stops: Stop[];
  /** Removed in this draft (shown struck through, can be put back). */
  removed: Stop[];
  note: string;
}

export function draftFrom(stops: { customer_id: number; note: string }[], note: string): Draft {
  return { stops: stops.map((s) => ({ customer_id: s.customer_id, note: s.note ?? '' })), removed: [], note: note ?? '' };
}

/** Moves the stop at `from` to `to` (both clamped); the same arrayMove as a drag end. */
export function moveStop<T>(list: T[], from: number, to: number): T[] {
  if (list.length === 0) return list;
  const f = Math.max(0, Math.min(list.length - 1, from));
  const t = Math.max(0, Math.min(list.length - 1, to));
  return f === t ? list : arrayMove(list, f, t);
}

export const moveUp = <T,>(list: T[], i: number): T[] => moveStop(list, i, i - 1);
export const moveDown = <T,>(list: T[], i: number): T[] => moveStop(list, i, i + 1);

/** "Move to #": a 1-based position typed in the seq field (clamped to the list). */
export function moveToPosition<T>(list: T[], i: number, position: number): T[] {
  if (!Number.isFinite(position)) return list;
  return moveStop(list, i, Math.round(position) - 1);
}

/** A dnd-kit drag end: the dragged id dropped over another id (ids are customer ids). */
export function dropMove(list: Stop[], activeId: string | number, overId: string | number | null | undefined): Stop[] {
  if (overId === null || overId === undefined || String(activeId) === String(overId)) return list;
  const from = list.findIndex((s) => String(s.customer_id) === String(activeId));
  const to = list.findIndex((s) => String(s.customer_id) === String(overId));
  if (from < 0 || to < 0) return list;
  return moveStop(list, from, to);
}

export function addStop(d: Draft, customerId: number, note = ''): Draft {
  if (d.stops.some((s) => s.customer_id === customerId)) return d;
  const back = d.removed.find((s) => s.customer_id === customerId);
  return {
    ...d,
    stops: [...d.stops, back ?? { customer_id: customerId, note }],
    removed: d.removed.filter((s) => s.customer_id !== customerId),
  };
}

export function removeStop(d: Draft, index: number): Draft {
  const s = d.stops[index];
  if (!s) return d;
  return { ...d, stops: d.stops.filter((_, i) => i !== index), removed: [...d.removed, s] };
}

/** Puts a removed stop back at the end of the list. */
export function restoreStop(d: Draft, customerId: number): Draft {
  return addStop(d, customerId);
}

export function setStopNote(d: Draft, index: number, note: string): Draft {
  return { ...d, stops: d.stops.map((s, i) => (i === index ? { ...s, note } : s)) };
}

export function sameStops(a: Stop[], b: Stop[]): boolean {
  return a.length === b.length && a.every((s, i) => s.customer_id === b[i].customer_id && (s.note ?? '') === (b[i].note ?? ''));
}

export function isDirty(d: Draft, base: { stops: Stop[]; note: string }): boolean {
  return !sameStops(d.stops, base.stops) || d.note !== (base.note ?? '');
}

/** Customers added and removed relative to the saved list (for the scope dialog's driver impact). */
export function draftDiff(base: Stop[], d: Draft): { added: number[]; removed: number[] } {
  const before = new Set(base.map((s) => s.customer_id));
  const after = new Set(d.stops.map((s) => s.customer_id));
  return {
    added: d.stops.filter((s) => !before.has(s.customer_id)).map((s) => s.customer_id),
    removed: base.filter((s) => !after.has(s.customer_id)).map((s) => s.customer_id),
  };
}
