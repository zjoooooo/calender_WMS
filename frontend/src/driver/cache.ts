// Device storage for the driver app (§7.2, §7.7), on IndexedDB through idb-keyval:
// - a small key-value wrapper (KV) that falls back to memory when IndexedDB is missing or blocked
//   (private mode), so the app still works for the current page load;
// - the offline cache of the last /driver/today and job responses, per user, shown at once with
//   their data time;
// - the stop-form drafts (saved on every change).
// The outbox (outbox.ts) uses the same KV wrapper for its stores.
import { createStore, del as idbDel, entries as idbEntries, get as idbGet, set as idbSet, type UseStore } from 'idb-keyval';

export interface KV<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
}

/** An in-memory KV (tests, and the fallback when IndexedDB does not work). */
export function memoryKV<T>(): KV<T> {
  const m = new Map<string, T>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
    entries: async () => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}

/** A KV in its own IndexedDB database (idb-keyval keeps one object store per database). */
export function idbKV<T>(dbName: string): KV<T> {
  const fallback = memoryKV<T>();
  let store: UseStore | null = null;
  let broken = typeof indexedDB === 'undefined';
  async function run<R>(fn: (s: UseStore) => Promise<R>, fb: () => Promise<R>): Promise<R> {
    if (broken) return fb();
    try {
      if (!store) store = createStore(dbName, 'kv');
      return await fn(store);
    } catch {
      broken = true;
      return fb();
    }
  }
  return {
    get: (k) => run((s) => idbGet<T>(k, s), () => fallback.get(k)),
    set: (k, v) => run((s) => idbSet(k, v, s), () => fallback.set(k, v)),
    del: (k) => run((s) => idbDel(k, s), () => fallback.del(k)),
    entries: () => run((s) => idbEntries<string, T>(s), () => fallback.entries()),
  };
}

// ---- response cache (§7.7: "The last /driver/today and job responses are cached per user") ----

export interface Cached<T> {
  data: T;
  /** Local time (ms) of the response, for "data from 10:12". */
  at: number;
}

let cacheKV: KV<Cached<unknown>> | null = null;
function cacheStore(): KV<Cached<unknown>> {
  if (!cacheKV) cacheKV = idbKV<Cached<unknown>>('wms-driver-cache');
  return cacheKV;
}

export const cacheKeys = {
  today: (uid: number) => `u${uid}:today`,
  job: (uid: number, date: string, job: string) => `u${uid}:job:${date}/${job}`,
  customers: (uid: number) => `u${uid}:customers`,
  submissions: (uid: number, date: string) => `u${uid}:job:${date}/submissions`, // pruned with the day's jobs
};

export async function readCache<T>(key: string): Promise<Cached<T> | undefined> {
  return (await cacheStore().get(key)) as Cached<T> | undefined;
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  await cacheStore().set(key, { data, at: Date.now() });
}

/** Drops this user's cached jobs of other dates (after the rollover, §8.4). */
export async function pruneCache(uid: number, today: string): Promise<void> {
  const prefix = `u${uid}:job:`;
  for (const [k] of await cacheStore().entries()) {
    if (k.startsWith(prefix) && !k.startsWith(prefix + today + '/')) await cacheStore().del(k);
  }
}

// ---- stop-form drafts (§7.2 "draft: saved to IndexedDB on every change") -----------------------

export interface DraftValues {
  weights: Record<string, string>;
  tickets: Record<string, string>;
  photos: string[];
  signature: string | null;
  note: string;
}

export interface Draft {
  values: DraftValues;
  saved_at: number;
}

let draftKV: KV<Draft> | null = null;
function draftStore(): KV<Draft> {
  if (!draftKV) draftKV = idbKV<Draft>('wms-driver-drafts');
  return draftKV;
}

export const draftKey = (uid: number, date: string, job: string, cid: number) => `u${uid}:${date}/${job}/${cid}`;

export const readDraft = (key: string) => draftStore().get(key);
export const writeDraft = (key: string, values: DraftValues) => draftStore().set(key, { values, saved_at: Date.now() });
export const deleteDraft = (key: string) => draftStore().del(key);

/** Drafts of one job (the Switch sheet warns about unsaved stop values, §7.5). */
export async function draftsOfJob(uid: number, date: string, job: string): Promise<Draft[]> {
  const prefix = `u${uid}:${date}/${job}/`;
  return (await draftStore().entries()).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
}

/** File names referenced by any draft (the outbox keeps those blobs). */
export async function draftFileNames(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [, d] of await draftStore().entries()) {
    for (const p of d.values.photos) out.add(p);
    if (d.values.signature) out.add(d.values.signature);
  }
  return out;
}
