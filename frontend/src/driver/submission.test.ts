// Free submissions on the phone: how an outbox entry is sent, the operational date, and the Today list.
import { describe, expect, it } from 'vitest';
import type { Submission } from '../api';
import { memoryKV } from './cache';
import { Outbox, type FileRec, type NotSentEntry, type OutboxEntry } from './outbox';
import { mergeSubmissions, opDateNow, outboxApi, subJob, subStop } from './submission';

const ID = '3f0c1b9d-6bcd-4f3a-9a1e-2b9d6a0c31f1';
const label = { customer: 'Only OTC Co', job_label: 'OTC', kind: 'submission' as const, weigh_types: ['OTC'], ticket_types: [] };

function fakeApi() {
  const calls: { path: string; body: any }[] = [];
  let rev = 0;
  const api = outboxApi({
    uploadFile: async () => ({ data: { path: '' }, warnings: [], status: 201 }) as any,
    putDriverStop: async (date, job, cid, body) => {
      calls.push({ path: `stop ${date}/${job}/${cid}`, body });
      return { data: { visit: { rev: 1 } }, warnings: [], status: 200 } as any;
    },
    putDriverSubmission: async (date, id, body) => {
      calls.push({ path: `submission ${date}/${id}`, body });
      return { data: { submission: body.outcome === null && rev === 0 ? null : { rev: ++rev }, replay: false }, warnings: [], status: 201 } as any;
    },
  });
  return { api, calls };
}
const box = (api: ReturnType<typeof fakeApi>['api']) =>
  new Outbox({ user: 3, api, outbox: memoryKV<OutboxEntry>(), files: memoryKV<FileRec>(), notsent: memoryKV<NotSentEntry>() });
const body = (weight: number) => ({ base_rev: 0, outcome: 'collected' as const, weights: { OTC: weight }, waste_type: 'OTC', customer_id: 50, vehicle_no: 'SBA1234X' });

describe('a submission in the outbox', () => {
  it('goes to PUT /driver/submissions/{date}/{id} with its own id; a route stop still goes to the run', async () => {
    const { api, calls } = fakeApi();
    const b = box(api);
    await b.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: { base_rev: 0, outcome: 'collected', weights: { REL: 10 } }, label: { ...label, kind: 'route' } });
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: body(300), label });
    const r = await b.flush();
    expect(r.sent).toBe(2);
    expect(calls.map((c) => c.path)).toEqual(['stop 2026-11-11/r5/12', `submission 2026-11-11/${ID}`]);
    expect(calls[1].body).toMatchObject({ waste_type: 'OTC', customer_id: 50, vehicle_no: 'SBA1234X', weights: { OTC: 300 } });
    expect(calls[1].body.op_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an edit made before the send replaces the waiting entry: one request, never two records', async () => {
    const { api, calls } = fakeApi();
    const b = box(api);
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: body(300), label });
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: body(320), label });
    await b.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.weights).toEqual({ OTC: 320 });
  });

  it('a later edit of a sent submission carries the rev the server answered', async () => {
    const { api, calls } = fakeApi();
    const b = box(api);
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: body(300), label });
    // queued behind the first one while it is "in flight" is not needed here: send, then queue the next
    await b.flush();
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: { ...body(310), base_rev: 1 }, label });
    await b.flush();
    expect(calls.map((c) => c.body.base_rev)).toEqual([0, 1]);
  });

  it('created and deleted before any signal: the delete is sent and the server has nothing to delete', async () => {
    const { api, calls } = fakeApi();
    const b = box(api);
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: body(300), label });
    await b.save({ date: '2026-11-11', job: subJob(ID), customer_id: 50, body: { base_rev: 0, outcome: null, waste_type: 'OTC', customer_id: 50 }, label });
    const r = await b.flush();
    expect(r).toMatchObject({ sent: 1, refused: 0, remaining: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.outcome).toBeNull();
  });
});

describe('operational date of a new submission', () => {
  const server = { today: '2026-11-11', now: '2026-11-11T22:00:00+08:00', day_ends_at: '2026-11-12T04:00:00+08:00' };
  const H = 3_600_000;
  it('is the server today until the rollover, measured by elapsed time only', () => {
    expect(opDateNow(server, 1000, 1000)).toBe('2026-11-11');
    expect(opDateNow(server, 1000, 1000 + 5.9 * H)).toBe('2026-11-11'); // 03:54 of the night shift
  });
  it('moves on at the rollover, also with no signal, and again every 24 h', () => {
    expect(opDateNow(server, 1000, 1000 + 6 * H)).toBe('2026-11-12');
    expect(opDateNow(server, 1000, 1000 + 29.9 * H)).toBe('2026-11-12');
    expect(opDateNow(server, 1000, 1000 + 30 * H)).toBe('2026-11-13');
    expect(opDateNow({ ...server, today: '2026-12-31' }, 0, 6 * H)).toBe('2027-01-01');
  });
  it('a wrong phone clock does not matter, and an older cached copy without day_ends_at keeps today', () => {
    expect(opDateNow(server, 5_000_000_000_000, 5_000_000_000_000 + H)).toBe('2026-11-11');
    expect(opDateNow(server, 2000, 1000)).toBe('2026-11-11'); // the clock went backwards
    expect(opDateNow({ today: '2026-11-11', now: server.now }, 0, 99 * H)).toBe('2026-11-11');
  });
});

describe('form stop and the Today list', () => {
  const types = { OTC: { code: 'OTC', name: 'OTC', abbr: 'OTC', unit: 'kg', weigh_method: 'weighbridge' as const, routable: false, confirm_over: 1000, active: true } };
  it('one weighable type; a ticket field only for a weighbridge type', () => {
    const s = subStop({ id: 50, name: 'Only OTC Co' }, 'OTC', types);
    expect(s.weigh_types).toEqual(['OTC']);
    expect(s.ticket_types).toEqual(['OTC']);
    expect(subStop({ id: 50, name: 'x' }, 'EROSE', types).ticket_types).toEqual([]);
    expect(s.visit).toBeNull();
  });
  it('merges the server list with unsent entries: a change shows, a delete hides, other dates and route stops are ignored', async () => {
    const rec = (id: string, w: number): Submission =>
      ({ id, date: '2026-11-11', waste_type: 'OTC', customer_id: 50, customer: { code: 'C0050', name: 'Only OTC Co', address: '' }, weights: { OTC: w }, vehicle_no: 'SBA1234X' }) as unknown as Submission;
    const entry = (id: string, date: string, b: any, job = subJob(id)): OutboxEntry =>
      ({ id: '1', key: '', user: 3, date, job, customer_id: 50, body: { op_id: 'x', base_rev: 0, ...b }, files: [], label, created_at: 0 });
    const list = mergeSubmissions(
      [rec('a', 100), rec('b', 200)],
      [
        entry('a', '2026-11-11', body(150)),
        entry('b', '2026-11-11', { outcome: null }),
        entry('c', '2026-11-11', body(70)),
        entry('d', '2026-11-10', body(1)),
        entry('e', '2026-11-11', body(2), 'r5'),
      ],
      '2026-11-11',
    );
    expect(list.map((x) => [x.id, x.weight, x.unsent])).toEqual([['a', 150, true], ['c', 70, true]]);
  });
});
