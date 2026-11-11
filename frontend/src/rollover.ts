// Rollover helpers (R1, R36). The client never computes the rollover from its own clock: it waits for
// (day_ends_at − now) as given by /api/meta, minus the time since that response arrived (measured on the
// local clock, which only has to tick at the right speed, not show the right time).
import type { QueryClient } from '@tanstack/react-query';
import { onToday } from './api';

/** ms until the rollover, plus a small margin, measured from `nowMs` (local clock). */
export function rolloverDelayMs(meta: { now: string; day_ends_at: string }, fetchedAtMs: number, nowMs: number, marginMs = 2000): number {
  const serverLeft = Date.parse(meta.day_ends_at) - Date.parse(meta.now);
  if (!Number.isFinite(serverLeft)) return 60 * 60_000; // unparsable: re-check in an hour
  const elapsed = Math.max(0, nowMs - fetchedAtMs);
  const ms = serverLeft - elapsed + marginMs;
  return Math.min(Math.max(ms, 1000), 2_147_000_000); // setTimeout's 32-bit limit
}

/** True when a response's `today` shows that the operational day changed. */
export function todayChanged(known: string | undefined, seen: string): boolean {
  return !!known && !!seen && known !== seen;
}

// ---- wiring used by the session (extracted so the §13 rollover-refetch test runs the real code) ----


/**
 * Listens to the `today` of every API response (meta, calendar polls, driver/today …). When it differs
 * from the known day (the rollover passed), moves the known day forward and invalidates EVERY query:
 * /api/meta, every calendar range (also one that does not contain today), lists, drawers and the
 * driver's Today list; active queries refetch at once. Returns the unsubscribe function.
 */
export function watchRollover(qc: Pick<QueryClient, 'invalidateQueries'>, known: { current: string | undefined }): () => void {
  return onToday((today) => {
    if (todayChanged(known.current, today)) {
      known.current = today;
      void qc.invalidateQueries();
    }
  });
}

/** The one refetch timer, set from the server's (day_ends_at − now). Returns a cancel function. */
export function armRolloverTimer(
  qc: Pick<QueryClient, 'invalidateQueries'>,
  meta: { now: string; day_ends_at: string },
  fetchedAtMs: number,
  nowMs: number = Date.now(),
): () => void {
  const timer = setTimeout(() => void qc.invalidateQueries(), rolloverDelayMs(meta, fetchedAtMs, nowMs));
  return () => clearTimeout(timer);
}
