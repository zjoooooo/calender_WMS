// outbox.ts (§7.7, §13): coalescing, order, files before the visit, the 200 / 409 / 422 / 401 / network
// handling and exactly-once delivery through a stable op_id. Runs on in-memory stores.
import { describe, expect, it } from 'vitest';
import { ApiError, type VisitWrite } from '../api';
import { memoryKV } from './cache';
import { Outbox, filesOf, nextFlushDelay, type FileRec, type NotSentEntry, type OutboxEntry, type OutboxEvent, type StopLabel } from './outbox';

const label: StopLabel = { customer: 'ABC Restaurant', job_label: 'N1', kind: 'route', weigh_types: ['REL'], ticket_types: [] };

type Step = 'ok' | ApiError | ((body: VisitWrite) => 'ok' | ApiError);

/** A fake server: records every call; visits are applied once per op_id (like R30's replay). */
function fakeApi() {
  const calls: string[] = [];
  const bodies: VisitWrite[] = [];
  const uploads: string[] = [];
  const applied = new Map<string, number>(); // op_id -> rev
  const revs = new Map<string, number>(); // stop -> rev
  const putSteps: Step[] = [];
  const uploadSteps: ('ok' | ApiError)[] = [];
  return {
    calls,
    bodies,
    uploads,
    applied,
    putSteps,
    uploadSteps,
    api: {
      async uploadFile(uuid: string, ext: string) {
        calls.push(`upload ${uuid}.${ext}`);
        const s = uploadSteps.shift() ?? 'ok';
        if (s !== 'ok') throw s;
        uploads.push(`${uuid}.${ext}`);
        return { data: { path: `files/${uuid.slice(0, 2)}/${uuid}.${ext}` }, warnings: [], status: 201 };
      },
      async putStop(date: string, job: string, cid: number, body: VisitWrite) {
        calls.push(`put ${date}/${job}/${cid}`);
        bodies.push(body);
        let s = putSteps.shift() ?? 'ok';
        if (typeof s === 'function') s = s(body);
        const key = `${date}/${job}/${cid}`;
        // the server applies the op even when the response is then lost
        let replay = true;
        if (!applied.has(body.op_id)) {
          replay = false;
          if (s === 'ok' || s.code === 'NETWORK_AFTER') {
            revs.set(key, (revs.get(key) ?? 0) + 1);
            applied.set(body.op_id, revs.get(key)!);
          }
        }
        if (s !== 'ok') throw s.code === 'NETWORK_AFTER' ? new ApiError('NETWORK', 0, 'lost response') : s;
        const rev = applied.get(body.op_id)!;
        return { data: { visit: { rev } as never, progress: {} as never, totals: {}, replay }, warnings: [], status: 200 };
      },
    },
  };
}

function setup(user = 3) {
  const fake = fakeApi();
  const stores = { outbox: memoryKV<OutboxEntry>(), files: memoryKV<FileRec>(), notsent: memoryKV<NotSentEntry>() };
  const events: OutboxEvent[] = [];
  const box = new Outbox({ user, api: fake.api, ...stores, onEvent: (e) => events.push(e) });
  return { fake, stores, events, box };
}

const collected = (kg: number, extra: Partial<VisitWrite> = {}) => ({
  base_rev: 0,
  outcome: 'collected' as const,
  weights: { REL: kg },
  tickets: {},
  photos: [] as string[],
  signature: null,
  reason: null,
  note: '',
  captured_at: '2026-11-11T09:00:00+08:00',
  ...extra,
});

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

describe('outbox', () => {
  it('uploads the photos and the signature before the visit, then drops the entry and its blobs', async () => {
    const { fake, stores, box, events } = setup();
    const photo = await box.addFile(jpeg(), 'jpg');
    const sig = await box.addFile(png(), 'png');
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(120.5, { photos: [photo], signature: sig }), label });
    const r = await box.flush();
    expect(r).toMatchObject({ sent: 1, stopped: null, remaining: 0 });
    expect(fake.calls).toEqual([`upload ${photo}`, `upload ${sig}`, 'put 2026-11-11/r5/12']);
    expect(fake.bodies[0]).toMatchObject({ photos: [photo], signature: sig, weights: { REL: 120.5 } });
    expect(await box.list()).toEqual([]);
    expect(await stores.files.entries()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['sent']);
  });

  it('sends entries one at a time in insertion order', async () => {
    const { fake, box } = setup();
    for (const cid of [30, 10, 20]) await box.save({ date: '2026-11-11', job: 'r5', customer_id: cid, body: collected(cid), label });
    await box.flush();
    expect(fake.calls).toEqual(['put 2026-11-11/r5/30', 'put 2026-11-11/r5/10', 'put 2026-11-11/r5/20']);
  });

  it('coalesces a new edit of the same stop: new body, new op_id, same place; unused blobs are deleted', async () => {
    const { fake, stores, box } = setup();
    const p1 = await box.addFile(jpeg(), 'jpg');
    const a = await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(100, { photos: [p1] }), label });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 13, body: collected(5), label });
    const b = await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(110), label });
    const list = await box.list();
    expect(list.map((e) => e.customer_id)).toEqual([12, 13]);
    expect(b.id).toBe(a.id);
    expect(b.body.op_id).not.toBe(a.body.op_id);
    expect(list[0].body.weights).toEqual({ REL: 110 });
    expect(await stores.files.get(p1)).toBeUndefined();
    await box.flush();
    expect(fake.bodies.map((x) => x.weights)).toEqual([{ REL: 110 }, { REL: 5 }]);
    expect(fake.uploads).toEqual([]);
  });

  it('queues an edit made while the first write is in flight, with the new base_rev', async () => {
    const { fake, box } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const origPut = fake.api.putStop;
    let firstCall = true;
    fake.api.putStop = async (...args) => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return origPut(...args);
    };
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(100), label });
    const running = box.flush();
    await new Promise((r) => setTimeout(r, 0));
    const second = await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(101), label });
    expect((await box.list()).length).toBe(2);
    expect(box.isInFlight(second.id)).toBe(false);
    release();
    const r = await running;
    expect(r.sent).toBe(2);
    expect(fake.bodies.map((x) => [x.weights?.REL, x.base_rev])).toEqual([
      [100, 0],
      [101, 1],
    ]);
  });

  it('keeps the entry on a network error and resends the SAME op_id: applied exactly once', async () => {
    const { fake, box, events } = setup();
    const photo = await box.addFile(jpeg(), 'jpg');
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(80, { photos: [photo] }), label });
    // 1st try: the upload fails (no signal)
    fake.uploadSteps.push(new ApiError('NETWORK', 0));
    let r = await box.flush();
    expect(r).toMatchObject({ sent: 0, stopped: 'network', remaining: 1 });
    // 2nd try: the server applies the visit but the response is lost
    fake.putSteps.push(new ApiError('NETWORK_AFTER', 0));
    r = await box.flush();
    expect(r).toMatchObject({ sent: 0, stopped: 'network', remaining: 1 });
    // 3rd try: the replay returns the recorded result
    r = await box.flush();
    expect(r).toMatchObject({ sent: 1, stopped: null, remaining: 0 });
    const ops = fake.bodies.map((b) => b.op_id);
    expect(new Set(ops).size).toBe(1);
    expect(fake.applied.size).toBe(1);
    expect(fake.uploads).toEqual([photo]); // uploaded once, then marked uploaded
    expect(events.filter((e) => e.type === 'stopped').length).toBe(2);
  });

  it('keeps the entry on a timeout or a 5xx', async () => {
    const { fake, box } = setup();
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    fake.putSteps.push(new ApiError('TIMEOUT', 0), new ApiError('INTERNAL', 500));
    expect((await box.flush()).stopped).toBe('network');
    expect((await box.flush()).stopped).toBe('network');
    expect((await box.flush()).sent).toBe(1);
  });

  it('drops the entry on 409 VISIT_CHANGED and goes on with the next', async () => {
    const { fake, box, events } = setup();
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 13, body: collected(2), label });
    fake.putSteps.push(new ApiError('VISIT_CHANGED', 409, '', null, { visit: { rev: 3 } }));
    const r = await box.flush();
    expect(r).toMatchObject({ sent: 1, conflicts: 1, refused: 0, remaining: 0 });
    expect(await box.listNotSent()).toEqual([]);
    const c = events.find((e) => e.type === 'conflict');
    expect(c && c.type === 'conflict' && c.error.details.visit.rev).toBe(3);
  });

  it('moves 409 NOT_HOLDER and 422 refusals to Not sent; resend and discard work', async () => {
    const { fake, stores, box } = setup();
    const photo = await box.addFile(jpeg(), 'jpg');
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1, { photos: [photo] }), label });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 13, body: collected(2), label });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 14, body: collected(3), label });
    fake.putSteps.push(new ApiError('NOT_HOLDER', 409), new ApiError('EDIT_WINDOW_CLOSED', 422, '', null, { deadline: 'x' }));
    const r = await box.flush();
    expect(r).toMatchObject({ sent: 1, refused: 2, remaining: 0 });
    const ns = await box.listNotSent();
    expect(ns.map((e) => [e.customer_id, e.error.code])).toEqual([
      [12, 'NOT_HOLDER'],
      [13, 'EDIT_WINDOW_CLOSED'],
    ]);
    expect(await stores.files.get(photo)).toBeDefined(); // still referenced by the Not sent entry
    const oldOp = ns[0].body.op_id;
    const again = await box.resend(ns[0].id);
    expect(again?.body.op_id).not.toBe(oldOp);
    expect((await box.list()).map((e) => e.customer_id)).toEqual([12]);
    await box.discardNotSent(ns[1].id);
    expect((await box.listNotSent()).length).toBe(0);
    expect((await box.flush()).sent).toBe(1);
    expect(await stores.files.get(photo)).toBeUndefined();
  });

  it('an edit can replace a Not sent entry', async () => {
    const { fake, box } = setup();
    await box.save({ date: '2026-11-11', job: 't6', customer_id: 12, body: collected(1), label });
    fake.putSteps.push(new ApiError('WEIGHT_INVALID', 422, '', 'weights.REL'));
    await box.flush();
    const [ns] = await box.listNotSent();
    await box.save({ date: '2026-11-11', job: 't6', customer_id: 12, body: collected(2), label, replacesNotSent: ns.id });
    expect(await box.listNotSent()).toEqual([]);
    expect((await box.list()).map((e) => e.body.weights)).toEqual([{ REL: 2 }]);
  });

  it('stops on 401 and keeps everything', async () => {
    const { fake, box } = setup();
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 13, body: collected(2), label });
    fake.putSteps.push(new ApiError('UNAUTHORIZED', 401));
    const r = await box.flush();
    expect(r).toMatchObject({ sent: 0, stopped: 'auth', remaining: 2 });
    expect(fake.calls.length).toBe(1);
    expect((await box.flush()).sent).toBe(2);
  });

  it('does not try while offline', async () => {
    const fake = fakeApi();
    let online = false;
    const box = new Outbox({
      user: 3,
      api: fake.api,
      outbox: memoryKV(),
      files: memoryKV(),
      notsent: memoryKV(),
      isOnline: () => online,
    });
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    expect((await box.flush()).stopped).toBe('network');
    expect(fake.calls).toEqual([]);
    online = true;
    expect((await box.flush()).sent).toBe(1);
  });

  it("never sends another user's entries", async () => {
    const fake = fakeApi();
    const stores = { outbox: memoryKV<OutboxEntry>(), files: memoryKV<FileRec>(), notsent: memoryKV<NotSentEntry>() };
    const ali = new Outbox({ user: 3, api: fake.api, ...stores });
    const bala = new Outbox({ user: 4, api: fake.api, ...stores });
    await ali.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    expect(await bala.list()).toEqual([]);
    expect((await bala.flush()).sent).toBe(0);
    expect(fake.calls).toEqual([]);
    expect((await ali.flush()).sent).toBe(1);
  });

  it('a single flush runs at a time', async () => {
    const { fake, box } = setup();
    await box.save({ date: '2026-11-11', job: 'r5', customer_id: 12, body: collected(1), label });
    const [a, b] = await Promise.all([box.flush(), box.flush()]);
    expect(a).toBe(b);
    expect(fake.calls.length).toBe(1);
  });

  it('helpers: filesOf and the retry backoff', () => {
    const u = '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1';
    expect(filesOf({ photos: [`files/0b/${u}.jpg`, 'bad'], signature: `${u}.png` })).toEqual([`${u}.jpg`, `${u}.png`]);
    expect([0, 1, 2, 3, 9].map(nextFlushDelay)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
  });
});
