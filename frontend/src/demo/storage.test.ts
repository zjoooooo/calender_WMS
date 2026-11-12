// The demo's saved copy (storage.ts, §11.5) with several tabs: a tab never overwrites what another tab saved
// or reset, and is told so. IndexedDB (idb-keyval) and BroadcastChannel are replaced by in-memory fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (k: string) => db.get(k),
  del: async (k: string) => void db.delete(k),
  // As idb-keyval: get and put in one transaction; an updater that throws writes nothing.
  update: async (k: string, fn: (v: unknown) => unknown) => void db.set(k, fn(db.get(k))),
}));

/** BroadcastChannel between the "tabs" of this test: delivers to every other channel of the same name. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(private name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && c.name === this.name) setTimeout(() => c.onmessage?.({ data }));
  }
}

const { Saver, loadSnapshot } = await import('./storage');
type SaverT = InstanceType<typeof Saver>;

const files = (text: string) => ({ 'routes.json': new TextEncoder().encode(text) });
const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle(s: SaverT) {
  for (let i = 0; i < 100 && s.state === 'pending'; i++) await tick();
  await tick(); // the other tabs' messages
  return s.state;
}
const stored = async () => new TextDecoder().decode((await loadSnapshot())!.files['routes.json']);
const tab = (base: string | null) => new Saver('v1', base, () => undefined, true);

beforeEach(() => {
  db.clear();
  FakeChannel.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});
afterEach(() => vi.unstubAllGlobals());

describe('Saver with several tabs', () => {
  it('one tab saves each change; its later saves build on its own', async () => {
    const a = tab(null);
    a.save(files('a1'));
    expect(await settle(a)).toBe('saved');
    a.save(files('a2'));
    expect(await settle(a)).toBe('saved');
    expect(await stored()).toBe('a2');
  });

  it('when another tab saved, this tab is told at once and its later changes do not overwrite', async () => {
    const a = tab(null);
    const b = tab(null);
    a.save(files('from A'));
    expect(await settle(a)).toBe('saved');
    expect(b.state).toBe('otherTab');
    b.save(files('from B'));
    expect(await settle(b)).toBe('otherTab');
    expect(await stored()).toBe('from A');
  });

  it('without BroadcastChannel the write itself finds that another tab saved', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const a = tab(null);
    const b = tab(null);
    a.save(files('from A'));
    expect(await settle(a)).toBe('saved');
    expect(b.state).toBe('saved');
    b.save(files('from B'));
    expect(await settle(b)).toBe('otherTab');
    expect(await stored()).toBe('from A');
  });

  it('a tab opened on the saved copy continues it', async () => {
    const a = tab(null);
    a.save(files('a1'));
    await settle(a);
    const b = tab((await loadSnapshot())!.rev);
    b.save(files('b1'));
    expect(await settle(b)).toBe('saved');
    expect(await stored()).toBe('b1');
    expect(a.state).toBe('otherTab');
  });

  it('Reset in one tab: the stored copy is gone and the other tabs stop saving', async () => {
    const a = tab(null);
    a.save(files('a1'));
    await settle(a);
    const b = tab((await loadSnapshot())!.rev);
    await a.reset();
    await tick();
    expect(await loadSnapshot()).toBeNull();
    expect(b.state).toBe('otherTab');
    b.save(files('b1'));
    expect(await settle(b)).toBe('otherTab');
    expect(await loadSnapshot()).toBeNull();
  });
});
