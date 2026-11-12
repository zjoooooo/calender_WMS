// The visitor's copy of the demo data in this browser (IndexedDB through idb-keyval, in its own database).
// Every access may fail or hang (storage blocked, private window, full disk): callers catch, and the demo
// then simply does not persist.
//
// Every tab of the demo runs its own backend on its own copy of the data, and saves the whole folder. So that
// one tab never silently overwrites what another tab saved, each save gets a new `rev`: a tab writes only
// while the stored copy is still the one it started from or last wrote itself (checked in the same IndexedDB
// transaction as the write). Otherwise, and as soon as another tab says that it saved or reset
// (BroadcastChannel), the tab stops saving and its banner asks to reload (state 'otherTab').
import { createStore, del, get, update, type UseStore } from 'idb-keyval';

export type DemoFiles = Record<string, Uint8Array>;

/** What is stored: the data folder's files, the demo version that wrote them and the mark of that save. */
export interface Snapshot {
  version: string;
  /** New on every save. */
  rev: string;
  saved_at: string;
  files: DemoFiles;
}

const KEY = 'data';
const CHANNEL = 'wms-demo';
const TIMEOUT_MS = 5000;
let store: UseStore | null = null;

function db(): UseStore {
  return (store ??= createStore('wms-demo', 'kv'));
}

function timed<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser storage did not answer')), TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function isSnapshot(v: any): v is Snapshot {
  return !!v && typeof v === 'object' && typeof v.version === 'string' && !!v.files && typeof v.files === 'object'
    && Object.values(v.files).every((f) => f instanceof Uint8Array);
}

/** The saved copy, or null. Throws when the browser does not allow storage. */
export async function loadSnapshot(): Promise<Snapshot | null> {
  const v = await timed(get(KEY, db()));
  return isSnapshot(v) ? v : null;
}

export function clearSnapshot(): Promise<void> {
  return timed(del(KEY, db()));
}

class StoredByOtherTab extends Error {}

/** Stores s when the stored copy is still the one of rev `base` (null: none); else throws StoredByOtherTab. */
function saveSnapshotOver(base: string | null, s: Snapshot): Promise<void> {
  return timed(
    update(
      KEY,
      (cur) => {
        if ((isSnapshot(cur) && typeof cur.rev === 'string' ? cur.rev : null) !== base) throw new StoredByOtherTab();
        return s;
      },
      db(),
    ),
  );
}

function newRev(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type SaveState = 'saved' | 'pending' | 'off' | 'otherTab';

/**
 * Saves the newest copy after each change, one write at a time (a newer copy replaces one still waiting).
 * `base`: the rev of the stored copy this tab started from (null: none). After a failed write it stops for
 * this visit (state 'off'); after another tab saved or reset, too (state 'otherTab', see above).
 */
export class Saver {
  private next: DemoFiles | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private channel: BroadcastChannel | null = null;
  state: SaveState;

  constructor(private version: string, private base: string | null, private onState: (s: SaveState) => void, enabled: boolean) {
    this.state = enabled ? 'saved' : 'off';
    onState(this.state);
    if (!enabled) return;
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => this.otherTab();
    } catch {
      /* no BroadcastChannel: the check at each write still holds */
    }
  }

  save(files: DemoFiles): void {
    if (this.state === 'off' || this.state === 'otherTab' || this.stopped) return;
    this.next = files;
    this.set('pending');
    this.running ??= this.pump().finally(() => (this.running = null));
  }

  /** The reset: stops saving (after the write in progress), drops the stored copy and tells the other tabs. */
  async reset(): Promise<void> {
    this.stopped = true;
    this.next = null;
    await this.running;
    await clearSnapshot().catch(() => undefined);
    this.tell();
  }

  private async pump(): Promise<void> {
    while (this.next && !this.stopped) {
      const files = this.next;
      this.next = null;
      const rev = newRev();
      try {
        await saveSnapshotOver(this.base, { version: this.version, rev, saved_at: new Date().toISOString(), files });
      } catch (e) {
        if (e instanceof StoredByOtherTab) this.otherTab();
        else this.set('off');
        return;
      }
      this.base = rev;
      this.tell();
    }
    if (!this.stopped && this.state === 'pending') this.set('saved');
  }

  private otherTab(): void {
    if (this.state === 'off' || this.stopped) return;
    this.next = null;
    this.set('otherTab');
  }

  private tell(): void {
    try {
      this.channel?.postMessage('changed');
    } catch {
      /* closed */
    }
  }

  private set(s: SaveState): void {
    this.state = s;
    this.onState(s);
  }
}
