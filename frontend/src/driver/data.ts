// Driver queries (§8.4): /api/driver/today and the open job, polled every 30 s while the page is
// visible and refetched after every action. Each response is also written to the device cache
// (cache.ts); with no signal the last cached copy is shown at once with its data time (§7.7).
// Also: merging the server's stop state with this phone's unsent outbox entries.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { ApiError, driverJob, driverToday, type DriverToday, type JobDetail, type JobStop, type MissReason, type Outcome, type WasteType } from '../api';
import { cacheKeys, readCache, writeCache, type Cached } from './cache';
import { useDriver } from './driverContext';
import type { OutboxEntry } from './outbox';

export const POLL_MS = 30_000;
export const TODAY_KEY = ['driver', 'today'] as const;
export const jobKey = (date: string, job: string) => ['driver', 'job', date, job] as const;

export interface Loaded<T> {
  data: T;
  /** Local time (ms) of the response. */
  at: number;
  /** true: the device copy, shown while offline or before the first answer. */
  cached: boolean;
}

/** No signal, a timeout or a server that cannot be reached (not a rule refusal). */
export function isOfflineError(e: unknown): boolean {
  return e instanceof ApiError && e.http === 0;
}

function useCachedQuery<T>(queryKey: readonly unknown[], cacheKey: string, fetcher: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const cached = useQuery({
    queryKey: ['driver-cache', cacheKey],
    queryFn: async () => (await readCache<T>(cacheKey)) ?? null,
    staleTime: Infinity,
    enabled,
  });
  return useQuery<Loaded<T>>({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      try {
        const data = await fetcher(signal);
        void writeCache(cacheKey, data).catch(() => undefined);
        return { data, at: Date.now(), cached: false };
      } catch (e) {
        if (isOfflineError(e)) {
          const c = await readCache<T>(cacheKey);
          if (c) return { data: c.data, at: c.at, cached: true };
        }
        throw e;
      }
    },
    placeholderData: cached.data ? { data: (cached.data as Cached<T>).data, at: (cached.data as Cached<T>).at, cached: true } : undefined,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 5_000,
  });
}

export function useToday() {
  const { me } = useDriver();
  return useCachedQuery<DriverToday>(TODAY_KEY, cacheKeys.today(me.id), (signal) => driverToday({ signal, timeoutMs: 15_000 }));
}

export function useJob(date: string, job: string, enabled = true) {
  const { me } = useDriver();
  return useCachedQuery<JobDetail>(jobKey(date, job), cacheKeys.job(me.id, date, job), (signal) => driverJob(date, job, { signal, timeoutMs: 15_000 }), enabled);
}

/** After a claim: the returned JobDetail becomes the job's data at once (and its cached copy). */
export function putJob(qc: QueryClient, uid: number, job: JobDetail): void {
  qc.setQueryData<Loaded<JobDetail>>(jobKey(job.date, job.job), { data: job, at: Date.now(), cached: false });
  void writeCache(cacheKeys.job(uid, job.date, job.job), job).catch(() => undefined);
}

/**
 * Jobs this phone just left itself (give back, finish, mark all): JobPage then does not report the
 * holder change as an office action. A new claim clears the mark.
 */
const selfReleased = new Set<string>();
export const markSelfRelease = (date: string, job: string) => void selfReleased.add(`${date}/${job}`);
export const clearSelfRelease = (date: string, job: string) => void selfReleased.delete(`${date}/${job}`);
export const isSelfRelease = (date: string, job: string) => selfReleased.has(`${date}/${job}`);

export function refreshDriver(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['driver'] });
}

// ---- waste types -------------------------------------------------------------------------------

export function typeMap(types: WasteType[] | undefined): Record<string, WasteType> {
  const out: Record<string, WasteType> = {};
  for (const w of types ?? []) out[w.code] = w;
  return out;
}

// ---- merging server state with unsent entries (§7.7 "The run view merges server state with unsent entries") ----

export interface EffVisit {
  outcome: Outcome | null;
  weights: Record<string, number | string>;
  tickets: Record<string, string>;
  photos: string[];
  signature: string | null;
  reason: MissReason | null;
  note: string;
  driver_id: number | null;
  rev: number;
  /** Still in this phone's outbox. */
  unsent: boolean;
}

/** The newest waiting entry per customer of one job. */
export function localEntries(entries: OutboxEntry[], date: string, job: string): Map<number, OutboxEntry> {
  const m = new Map<number, OutboxEntry>();
  for (const e of entries) if (e.date === date && e.job === job) m.set(e.customer_id, e);
  return m;
}

export function effectiveVisit(stop: JobStop, local: OutboxEntry | undefined, myId: number): EffVisit | null {
  if (local) {
    const b = local.body;
    return {
      outcome: b.outcome,
      weights: b.weights ?? {},
      tickets: b.tickets ?? {},
      photos: b.photos ?? [],
      signature: b.signature ?? null,
      reason: b.reason ?? null,
      note: b.note ?? '',
      driver_id: myId,
      rev: b.base_rev,
      unsent: true,
    };
  }
  const v = stop.visit;
  if (!v) return null;
  return { ...v, weights: v.weights ?? {}, tickets: v.tickets ?? {}, photos: v.photos ?? [], unsent: false };
}

export interface Progress {
  collected: number;
  missed: number;
  pending: number;
  total: number;
  totals: Record<string, number>;
}

function num(v: number | string | undefined): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Counts and per-type totals of a job, with this phone's unsent results applied. */
export function mergedProgress(job: JobDetail, local: Map<number, OutboxEntry>, myId: number): Progress {
  const p: Progress = { collected: 0, missed: 0, pending: 0, total: 0, totals: {} };
  for (const s of job.stops) {
    const v = effectiveVisit(s, local.get(s.customer.id), myId);
    if (v?.outcome === 'collected') {
      for (const [k, w] of Object.entries(v.weights)) p.totals[k] = Math.round(((p.totals[k] ?? 0) + num(w)) * 10) / 10;
    }
    if (!s.on_plan) continue; // an off-plan stop counts only in the totals (R21: the plan is the stop list)
    p.total++;
    if (v?.outcome === 'collected') p.collected++;
    else if (v?.outcome === 'missed') p.missed++;
    else p.pending++;
  }
  return p;
}

/** The next pending stop after `afterCid` in seq order (wrapping around), skipping `skip`. */
export function nextPendingStop(job: JobDetail, local: Map<number, OutboxEntry>, myId: number, afterCid: number | null, skip: number[] = []): JobStop | null {
  const stops = job.stops.filter((s) => s.on_plan);
  const start = afterCid === null ? -1 : stops.findIndex((s) => s.customer.id === afterCid);
  for (let i = 1; i <= stops.length; i++) {
    const s = stops[(start + i + stops.length) % stops.length];
    if (skip.includes(s.customer.id)) continue;
    if (effectiveVisit(s, local.get(s.customer.id), myId)?.outcome == null) return s;
  }
  return null;
}
