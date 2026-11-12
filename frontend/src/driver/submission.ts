// Free submissions on the phone (OTC, COMPACTOR, EROSE …: nothing is planned, nothing is claimed).
// A submission travels through the same outbox as a route stop (outbox.ts): its entry has the job
// 'sub:<uuid>', where the uuid is made on the phone and names the record on the server, so a resend can
// never create a second one. Its date is the operational date the phone made it on.
import { putDriverStop, putDriverSubmission, uploadFile, type ApiResult, type DriverVisitResult, type JobStop, type Submission, type Visit, type WasteType } from '../api';
import type { OutboxApi, OutboxEntry } from './outbox';

export const SUB_PREFIX = 'sub:';
export const isSubJob = (job: string) => job.startsWith(SUB_PREFIX);
export const subJob = (id: string) => SUB_PREFIX + id;
export const subId = (job: string) => job.slice(SUB_PREFIX.length);

/**
 * What the outbox sends with: a route stop goes to PUT /driver/runs/…/stops/…, a submission entry to
 * PUT /driver/submissions/{date}/{id}. The submission's answer is given the shape of a visit answer, so
 * the outbox reads the new rev the same way.
 */
export function outboxApi(api = { uploadFile, putDriverStop, putDriverSubmission }): OutboxApi {
  return {
    uploadFile: api.uploadFile,
    putStop: async (date, job, customerId, body, opts) => {
      if (!isSubJob(job)) return api.putDriverStop(date, job, customerId, body, opts);
      const r = await api.putDriverSubmission(date, subId(job), { ...body, customer_id: customerId }, opts);
      const data = { visit: r.data.submission as unknown as Visit, progress: { collected: 0, missed: 0, pending: 0, total: 0 }, totals: {}, replay: r.data.replay };
      return { ...r, data } as ApiResult<DriverVisitResult>;
    },
  };
}

const DAY_MS = 86_400_000;

/**
 * The operational date now, for a new submission made with or without signal. The phone's clock is never
 * read as a date: the server said `today`, `now` and `day_ends_at` in a response that arrived at
 * `fetchedAtMs` (local clock); only the time passed since then is measured. Before the rollover it is
 * `today`; after it, one day later for every 24 h past the rollover.
 */
export function opDateNow(server: { today: string; now: string; day_ends_at?: string }, fetchedAtMs: number, nowMs: number): string {
  const left = Date.parse(server.day_ends_at ?? '') - Date.parse(server.now);
  const elapsed = Math.max(0, nowMs - fetchedAtMs);
  if (!Number.isFinite(left) || elapsed < left) return server.today;
  const days = 1 + Math.floor((elapsed - left) / DAY_MS);
  const [y, m, d] = server.today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The form's "stop" of a submission: one customer, one weighable type (a ticket when it is weighed at a weighbridge). */
export function subStop(
  customer: { id: number; code?: string; name: string; address?: string },
  wasteType: string,
  types: Record<string, WasteType>,
  record?: Submission | null,
): JobStop {
  return {
    seq: 1,
    on_plan: true,
    stop_note: '',
    customer: { id: customer.id, code: customer.code ?? '', name: customer.name, address: customer.address ?? '', phone: '', note: '' },
    weigh_types: [wasteType],
    ticket_types: types[wasteType]?.weigh_method === 'weighbridge' ? [wasteType] : [],
    also_on: [],
    visit: record
      ? { outcome: record.outcome, weights: record.weights, tickets: record.tickets, photos: record.photos, signature: record.signature, reason: null, note: record.note,
          driver_id: record.driver_id, rev: record.rev, captured_at: record.captured_at, flags: record.flags }
      : null,
  };
}

export interface MySubmission {
  id: string;
  date: string;
  waste_type: string;
  customer_id: number;
  customer: string;
  weight: number | string;
  vehicle_no: string | null;
  /** Still in this phone's outbox. */
  unsent: boolean;
}

/** The driver's submissions of one date: the server's list with this phone's unsent entries applied. */
export function mergeSubmissions(server: Submission[], entries: OutboxEntry[], date: string): MySubmission[] {
  const out = new Map<string, MySubmission | null>();
  for (const s of server) {
    out.set(s.id, { id: s.id, date: s.date, waste_type: s.waste_type, customer_id: s.customer_id, customer: s.customer.name,
      weight: s.weights[s.waste_type] ?? 0, vehicle_no: s.vehicle_no, unsent: false });
  }
  for (const e of entries) {
    if (!isSubJob(e.job) || e.date !== date) continue;
    const id = subId(e.job);
    const type = e.body.waste_type ?? e.label.weigh_types[0] ?? '';
    // an unsent delete hides the row; an unsent create or change shows the phone's values
    out.set(id, e.body.outcome === null ? null
      : { id, date, waste_type: type, customer_id: e.customer_id, customer: e.label.customer, weight: e.body.weights?.[type] ?? 0, vehicle_no: e.body.vehicle_no ?? null, unsent: true });
  }
  return [...out.values()].filter((x): x is MySubmission => x !== null);
}
