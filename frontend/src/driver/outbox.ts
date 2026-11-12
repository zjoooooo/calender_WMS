// Offline outbox of driver result writes (§7.7, R30), on IndexedDB via idb-keyval.
//
// Stores (each a KV, see cache.ts):
//   files    '<uuid>.<ext>' -> {blob, ext, uploaded}     photos and signatures taken on this phone
//   outbox   '<seq>'        -> OutboxEntry                one unsent result write per stop, in insertion order
// A free submission (no plan, no claim) is an entry too: its job is 'sub:<uuid>' (the id made on the phone,
// see submission.ts) and its body also carries waste_type, customer_id and vehicle_no; the OutboxApi the
// app passes in sends such an entry to PUT /driver/submissions/{date}/{id}. Everything else is the same.
//   notsent  '<seq>'        -> NotSentEntry               entries the server refused (S7)
// An entry's `key` is '<date>/<job>/<customer_id>'; entries also carry the user id, so a second driver
// signing in on the same phone never sends the first driver's entries.
//
// Rules:
// - Coalescing: a new edit of the same stop replaces the waiting entry (new body, new op_id, same place in
//   the queue), unless that entry is in flight; then the edit is queued behind it. Blobs that nothing
//   references any more are deleted.
// - Flush: one entry at a time, in insertion order, 15 s timeout. Its photos and signature are uploaded
//   first (PUT /api/files/..., idempotent), then the visit is sent with PUT. The op_id is kept across
//   retries, so a write whose response was lost is a replay on the server (exactly once).
// - 200 (also a replay): the entry and its blobs are dropped; later entries of the same stop get the new
//   base_rev. 409 VISIT_CHANGED: dropped, the caller shows the server value. 409 NOT_HOLDER and every
//   other 4xx refusal: moved to Not sent. 401/403: kept, flushing stops. Network error, timeout or 5xx:
//   kept, flushing stops and is retried later (nextFlushDelay backs off from 15 s to 60 s).
import { ApiError, type ApiResult, type DriverVisitResult, type FileExt, type RequestOptions, type VisitWrite } from '../api';
import { uuidv4 } from '../ui/uuid';
import { idbKV, type KV } from './cache';

export const SEND_TIMEOUT_MS = 15_000;

export interface FileRec {
  blob: Blob;
  ext: FileExt;
  uploaded: boolean;
  user: number;
  created_at: number;
}

/** What the screens need to show an entry without the job (Not sent, a form opened offline). */
export interface StopLabel {
  customer: string;
  /** Route code, or the submission's waste type. */
  job_label: string;
  kind: 'route' | 'submission';
  weigh_types: string[];
  ticket_types: string[];
}

/** The body as stored: op_id is set by the outbox. */
export type EntryBody = Omit<VisitWrite, 'op_id'> & { op_id: string };

export interface OutboxEntry {
  id: string;
  key: string;
  user: number;
  date: string;
  job: string;
  customer_id: number;
  body: EntryBody;
  /** File names ('<uuid>.jpg' / '<uuid>.png') referenced by the body. */
  files: string[];
  label: StopLabel;
  created_at: number;
}

export interface StoredError {
  code: string;
  http: number;
  message: string;
  field: string | null;
  details: unknown;
}

export interface NotSentEntry extends OutboxEntry {
  error: StoredError;
  refused_at: number;
}

export interface SaveInput {
  date: string;
  job: string;
  customer_id: number;
  body: Omit<VisitWrite, 'op_id'>;
  label: StopLabel;
  /** A Not sent entry that this edit replaces (S7 "edit and resend"). */
  replacesNotSent?: string;
}

export type OutboxEvent =
  | { type: 'sent'; entry: OutboxEntry; result: ApiResult<DriverVisitResult> }
  | { type: 'conflict'; entry: OutboxEntry; error: ApiError }
  | { type: 'refused'; entry: NotSentEntry }
  | { type: 'stopped'; reason: 'network' | 'auth'; error: ApiError };

export interface FlushResult {
  sent: number;
  conflicts: number;
  refused: number;
  /** Why flushing stopped before the outbox was empty (null: nothing left to send). */
  stopped: null | 'network' | 'auth';
  remaining: number;
}

export interface OutboxApi {
  uploadFile(uuid: string, ext: FileExt, blob: Blob, opts?: RequestOptions): Promise<unknown>;
  putStop(date: string, job: string, customerId: number, body: VisitWrite, opts?: RequestOptions): Promise<ApiResult<DriverVisitResult>>;
}

export interface OutboxDeps {
  user: number;
  outbox: KV<OutboxEntry>;
  files: KV<FileRec>;
  notsent: KV<NotSentEntry>;
  api: OutboxApi;
  /** Extra file references to keep (drafts). */
  extraRefs?: () => Promise<Set<string>>;
  onEvent?: (e: OutboxEvent) => void;
  timeoutMs?: number;
  /** false: do not even try (navigator.onLine). */
  isOnline?: () => boolean;
}

export const stopKey = (date: string, job: string, customerId: number) => `${date}/${job}/${customerId}`;

const NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png)$/;

/** '<uuid>.<ext>' of a file name or stored path ('files/0b/<uuid>.jpg'); null when not a file name. */
export function fileName(pathOrName: string): string | null {
  const name = pathOrName.split('/').pop() || '';
  return NAME_RE.test(name) ? name : null;
}

/** The file names a body references (photos and signature). */
export function filesOf(body: Pick<VisitWrite, 'photos' | 'signature'>): string[] {
  const out: string[] = [];
  for (const p of [...(body.photos ?? []), ...(body.signature ? [body.signature] : [])]) {
    const n = fileName(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Delay before the next automatic flush: 15 s, backing off to 60 s while sending fails (§7.7). */
export function nextFlushDelay(failures: number): number {
  return Math.min(60_000, 15_000 * 2 ** Math.max(0, failures));
}

function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError('NETWORK', 0, e instanceof Error ? e.message : String(e));
}

export class Outbox {
  private readonly d: OutboxDeps;
  private chain: Promise<unknown> = Promise.resolve();
  private inflight: string | null = null;
  private running: Promise<FlushResult> | null = null;

  constructor(deps: OutboxDeps) {
    this.d = deps;
  }

  get user(): number {
    return this.d.user;
  }

  /** Runs fn after every earlier locked call (a tiny mutex: saves never race the flush loop). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** This user's waiting entries, oldest first. */
  async list(): Promise<OutboxEntry[]> {
    return (await this.d.outbox.entries()).map(([, e]) => e).filter((e) => e.user === this.d.user).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async listNotSent(): Promise<NotSentEntry[]> {
    return (await this.d.notsent.entries()).map(([, e]) => e).filter((e) => e.user === this.d.user).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** True while the entry is being sent (the UI may still show it as unsent). */
  isInFlight(id: string): boolean {
    return this.inflight === id;
  }

  private async nextId(): Promise<string> {
    let max = 0;
    for (const [k] of await this.d.outbox.entries()) max = Math.max(max, Number(k) || 0);
    for (const [k] of await this.d.notsent.entries()) max = Math.max(max, Number(k) || 0);
    return String(Math.max(max + 1, 1)).padStart(12, '0');
  }

  /** Stores a photo or signature taken on this phone; returns its name '<uuid>.<ext>'. */
  async addFile(blob: Blob, ext: FileExt): Promise<string> {
    const name = `${uuidv4()}.${ext}`;
    await this.d.files.set(name, { blob, ext, uploaded: false, user: this.d.user, created_at: Date.now() });
    return name;
  }

  async getFile(name: string): Promise<FileRec | undefined> {
    const n = fileName(name);
    return n ? this.d.files.get(n) : undefined;
  }

  /** Queues a result write (coalesced with a waiting entry of the same stop). */
  save(input: SaveInput): Promise<OutboxEntry> {
    return this.locked(async () => {
      const key = stopKey(input.date, input.job, input.customer_id);
      const body: EntryBody = { ...input.body, op_id: uuidv4() };
      const files = filesOf(body);
      const waiting = (await this.list()).filter((e) => e.key === key && e.id !== this.inflight).pop();
      let entry: OutboxEntry;
      if (waiting) {
        entry = { ...waiting, body, files, label: input.label };
      } else {
        entry = {
          id: await this.nextId(),
          key,
          user: this.d.user,
          date: input.date,
          job: input.job,
          customer_id: input.customer_id,
          body,
          files,
          label: input.label,
          created_at: Date.now(),
        };
      }
      await this.d.outbox.set(entry.id, entry);
      let dropped: string[] = waiting ? waiting.files : [];
      if (input.replacesNotSent) {
        const ns = await this.d.notsent.get(input.replacesNotSent);
        if (ns && ns.user === this.d.user) {
          await this.d.notsent.del(ns.id);
          dropped = dropped.concat(ns.files);
        }
      }
      await this.gc(dropped);
      return entry;
    });
  }

  /** Moves a Not sent entry back to the end of the outbox with a new op_id (S7 "Resend"). */
  resend(notSentId: string): Promise<OutboxEntry | null> {
    return this.locked(async () => {
      const ns = await this.d.notsent.get(notSentId);
      if (!ns || ns.user !== this.d.user) return null;
      const { error: _e, refused_at: _r, ...rest } = ns;
      const entry: OutboxEntry = { ...rest, id: await this.nextId(), body: { ...ns.body, op_id: uuidv4() } };
      await this.d.outbox.set(entry.id, entry);
      await this.d.notsent.del(ns.id);
      return entry;
    });
  }

  /** Deletes a Not sent entry (after the driver told the office) and its unused blobs. */
  discardNotSent(notSentId: string): Promise<void> {
    return this.locked(async () => {
      const ns = await this.d.notsent.get(notSentId);
      if (!ns || ns.user !== this.d.user) return;
      await this.d.notsent.del(ns.id);
      await this.gc(ns.files);
    });
  }

  /** Deletes the given blobs unless an entry (or a draft) still references them. */
  private async gc(names: string[]): Promise<void> {
    if (!names.length) return;
    const keep = new Set<string>(this.d.extraRefs ? await this.d.extraRefs() : []);
    for (const [, e] of await this.d.outbox.entries()) e.files.forEach((f) => keep.add(f));
    for (const [, e] of await this.d.notsent.entries()) e.files.forEach((f) => keep.add(f));
    for (const n of names) if (!keep.has(n)) await this.d.files.del(n);
  }

  /** Sends every waiting entry once (single flight: a second call joins the running one). */
  flush(): Promise<FlushResult> {
    if (!this.running) {
      this.running = this.doFlush().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doFlush(): Promise<FlushResult> {
    const res: FlushResult = { sent: 0, conflicts: 0, refused: 0, stopped: null, remaining: 0 };
    const timeoutMs = this.d.timeoutMs ?? SEND_TIMEOUT_MS;
    for (;;) {
      if (this.d.isOnline && !this.d.isOnline()) {
        if ((await this.list()).length) {
          res.stopped = 'network';
          this.d.onEvent?.({ type: 'stopped', reason: 'network', error: new ApiError('NETWORK', 0, 'offline') });
        }
        break;
      }
      const entry = await this.locked(async () => {
        const next = (await this.list())[0];
        this.inflight = next ? next.id : null;
        return next;
      });
      if (!entry) break;
      try {
        // 1. files first (idempotent on the server: 201 or 200)
        for (const name of entry.files) {
          const rec = await this.d.files.get(name);
          if (!rec || rec.uploaded) continue; // not taken on this phone: already on the server
          const m = NAME_RE.exec(name)!;
          await this.d.api.uploadFile(m[1], m[2] as FileExt, rec.blob, { timeoutMs });
          await this.d.files.set(name, { ...rec, uploaded: true });
        }
        // 2. the visit (same op_id on every retry: a lost response becomes a replay)
        const result = await this.d.api.putStop(entry.date, entry.job, entry.customer_id, entry.body, { timeoutMs });
        await this.locked(async () => {
          await this.d.outbox.del(entry.id);
          this.inflight = null;
          const rev = result.data?.visit?.rev;
          if (typeof rev === 'number') {
            for (const e of await this.list()) {
              if (e.key === entry.key) await this.d.outbox.set(e.id, { ...e, body: { ...e.body, base_rev: rev } });
            }
          }
          await this.gc(entry.files);
        });
        res.sent++;
        this.d.onEvent?.({ type: 'sent', entry, result });
      } catch (raw) {
        const e = asApiError(raw);
        if (e.http === 0 || e.http >= 500) {
          this.inflight = null;
          res.stopped = 'network';
          this.d.onEvent?.({ type: 'stopped', reason: 'network', error: e });
          break;
        }
        if (e.http === 401 || e.http === 403) {
          this.inflight = null;
          res.stopped = 'auth';
          this.d.onEvent?.({ type: 'stopped', reason: 'auth', error: e });
          break;
        }
        if (e.code === 'VISIT_CHANGED') {
          await this.locked(async () => {
            await this.d.outbox.del(entry.id);
            this.inflight = null;
            await this.gc(entry.files);
          });
          res.conflicts++;
          this.d.onEvent?.({ type: 'conflict', entry, error: e });
          continue;
        }
        // NOT_HOLDER, EDIT_WINDOW_CLOSED, NOT_ON_JOB, any other 422, 404, 413 ...: Not sent (S7)
        const ns: NotSentEntry = {
          ...entry,
          error: { code: e.code, http: e.http, message: e.message, field: e.field, details: e.details ?? null },
          refused_at: Date.now(),
        };
        await this.locked(async () => {
          await this.d.notsent.set(ns.id, ns);
          await this.d.outbox.del(entry.id);
          this.inflight = null;
        });
        res.refused++;
        this.d.onEvent?.({ type: 'refused', entry: ns });
      }
    }
    res.remaining = (await this.list()).length;
    return res;
  }
}

/** The browser outbox of one user, on IndexedDB. */
export function createIdbOutbox(user: number, api: OutboxApi, extra: Pick<OutboxDeps, 'extraRefs' | 'onEvent' | 'isOnline'> = {}): Outbox {
  return new Outbox({
    user,
    api,
    outbox: idbKV<OutboxEntry>('wms-outbox'),
    files: idbKV<FileRec>('wms-files'),
    notsent: idbKV<NotSentEntry>('wms-notsent'),
    ...extra,
  });
}
