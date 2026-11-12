// The calendar demo build (§11.5): starts the real backend in this tab (runtime.ts), restores the visitor's
// saved copy of the data or the bundled demo data, signs in as the demo admin and opens the office app on
// the calendar, with the demo banner. A loading screen shows the download; an error screen says what failed.
//
// Data: the bundle's `version` stands for its backend code and data (vite.demo.ts). A saved copy of another
// version is dropped (notice "updated"); one that no longer opens is replaced by the bundled data (notice
// "restored"). Only the visitor's changes are saved, not the start's own writes (the sign-in), so a visitor
// who changed nothing has no saved copy and always gets the data of the latest deploy. Without browser
// storage the demo works the same, it only forgets the changes on reload (notice "noStorage"). Several tabs:
// see storage.ts (notice "otherTab").
//
// Today: the visitor's date, in the visitor's time zone. The data was made in Singapore time and its days
// before then are frozen (R13); where the visitor's date is still before that (west of Singapore, in the
// first hours after a deploy) the backend answers CLOCK_BEHIND_FREEZE, and the demo then runs on the
// backend's own zone, Asia/Singapore, for this visit.
import { useEffect, useState } from 'react';
import { bundleUrl } from 'virtual:wms-demo-bundle';
import * as api from '../api';
import type { Lang, LoginResult } from '../api';
import App from '../App';
import { DemoBar, type DemoControl } from './DemoBar';
import { clearSnapshot, loadSnapshot, Saver, type DemoFiles, type SaveState, type Snapshot } from './storage';
import { demoText, type DemoKey } from './texts';
import './demo.css';

type FileText = string | { b64: string };
interface Bundle {
  version: string;
  built_at: string;
  today: string;
  login: { username: string; password: string };
  backend: Record<string, FileText>;
  data: Record<string, FileText>;
}

type Boot =
  | { phase: 'runtime'; loaded: number; total: number }
  | { phase: 'data' | 'start' | 'signin' }
  | { phase: 'ready'; control: DemoControl }
  | { phase: 'error'; message: string };

function decode(files: Record<string, FileText>): DemoFiles {
  const enc = new TextEncoder();
  const out: DemoFiles = {};
  for (const [path, f] of Object.entries(files)) {
    out[path] = typeof f === 'string' ? enc.encode(f) : Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
  }
  return out;
}

/** The language of the loading screen and of a fresh start: this browser's last choice, else its language. */
function visitorLang(): Lang {
  const v = api.prefs.get('lang');
  if (v === 'zh' || v === 'en') return v;
  return /^zh\b/i.test(typeof navigator === 'undefined' ? '' : navigator.language || '') ? 'zh' : 'en';
}

async function boot(show: (b: Boot) => void): Promise<DemoControl> {
  show({ phase: 'runtime', loaded: 0, total: 0 });
  const runtimeP = import('./runtime');
  const bundleP = fetch(bundleUrl).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${bundleUrl}`);
    return r.json() as Promise<Bundle>;
  });
  bundleP.catch(() => undefined);
  const savedP: Promise<{ storage: boolean; snapshot: Snapshot | null }> = loadSnapshot().then(
    (snapshot) => ({ storage: true, snapshot }),
    () => ({ storage: false, snapshot: null }),
  );

  const runtime = await runtimeP;
  const php = await runtime.loadPhp((p) => show({ phase: 'runtime', ...p }));
  show({ phase: 'data' });
  const [bundle, saved] = await Promise.all([bundleP, savedP]);
  const notices: DemoKey[] = [];
  const original = decode(bundle.data);
  let restored = saved.snapshot?.version === bundle.version;
  if (saved.snapshot && !restored) {
    notices.push('notice.updated');
    await clearSnapshot().catch(() => undefined);
  }

  show({ phase: 'start' });
  const saveListeners = new Set<(s: SaveState) => void>();
  const onSaveState = (s: SaveState) => {
    document.documentElement.dataset.demoSave = s; // read by e2e/demo.e2e.cjs
    saveListeners.forEach((fn) => fn(s));
  };
  // The start's own writes (the sign-in, the language) are not saved: saving starts once the demo is open.
  let save = (_files: DemoFiles): void => undefined;
  const backend = runtime.startBackend(php, {
    backend: decode(bundle.backend),
    data: restored ? saved.snapshot!.files : original,
    timeZone: runtime.visitorTimeZone(),
    onChange: (files) => save(files),
  });
  api.setInBrowserBackend(backend.handle);

  show({ phase: 'signin' });
  const signIn = (): Promise<LoginResult> => api.login(bundle.login.username, bundle.login.password);
  const firstSignIn = (): Promise<LoginResult> =>
    signIn().catch((e) => {
      if (!api.isApiError(e, 'CLOCK_BEHIND_FREEZE')) throw e;
      backend.useTimeZone(null);
      return signIn();
    });
  let r: LoginResult;
  try {
    r = await firstSignIn();
  } catch (e) {
    if (!restored) throw e;
    // The saved copy no longer opens (it cannot normally happen): start again from the bundled data.
    backend.replaceData(original);
    backend.useTimeZone(runtime.visitorTimeZone());
    restored = false;
    notices.push('notice.restored');
    await clearSnapshot().catch(() => undefined);
    r = await firstSignIn();
  }
  api.setToken(r.token);
  const lang = visitorLang();
  if (!restored && r.user.lang !== lang) await api.patchMe({ lang }).catch(() => undefined);
  // The API of the backend in this tab, for e2e/demo.e2e.cjs (and anyone curious, in the dev tools).
  (window as any).__wmsDemo = { api: (method: string, path: string, body?: unknown) => api.request(method, path, body) };
  const saver = new Saver(bundle.version, restored ? (saved.snapshot!.rev ?? null) : null, onSaveState, saved.storage);
  save = (files) => saver.save(files);

  return {
    notices,
    saveState: () => saver.state,
    onSaveState: (fn) => {
      saveListeners.add(fn);
      return () => void saveListeners.delete(fn);
    },
    signIn,
    reset: async () => {
      await saver.reset();
      location.reload();
    },
  };
}

// Started once per page (not per React mount: StrictMode mounts twice in development).
let started: Promise<DemoControl> | null = null;
let current: Boot = { phase: 'runtime', loaded: 0, total: 0 };
const watchers = new Set<(b: Boot) => void>();
function setBoot(b: Boot) {
  current = b;
  watchers.forEach((fn) => fn(b));
}

export default function DemoApp() {
  const [state, setState] = useState<Boot>(current);
  useEffect(() => {
    watchers.add(setState);
    setState(current);
    started ??= boot(setBoot).then(
      (control) => (setBoot({ phase: 'ready', control }), control),
      (e) => {
        console.error(e);
        setBoot({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
        throw e;
      },
    );
    started.catch(() => undefined);
    return () => void watchers.delete(setState);
  }, []);

  if (state.phase === 'ready') return <App top={<DemoBar control={state.control} />} />;
  return <BootScreen state={state} />;
}

function BootScreen({ state }: { state: Exclude<Boot, { phase: 'ready' }> }) {
  const lang = visitorLang();
  const t = (k: DemoKey, v?: Record<string, string | number>) => demoText(lang, k, v);
  const mb = (n: number) => (n / 1e6).toFixed(1);
  useEffect(() => {
    document.title = t('title');
  });
  return (
    <div className="center-screen" lang={lang}>
      <div className="card demo-boot" role="status" aria-live="polite">
        <h1>{t('title')}</h1>
        {state.phase === 'error' ? (
          <>
            <p className="form-error">
              {t('error.title')}: {state.message}
            </p>
            <p className="muted small">{t('error.hint')}</p>
            <button type="button" className="btn primary" onClick={() => location.reload()}>
              {t('error.retry')}
            </button>
          </>
        ) : state.phase === 'runtime' ? (
          <>
            <p>{t('load.runtime')}</p>
            <progress max={state.total || 1} value={state.loaded} aria-label={t('load.runtime')} />
            <p className="muted small num">
              {state.total ? `${t('load.size', { done: mb(state.loaded), total: mb(state.total) })} · ${Math.floor((100 * state.loaded) / state.total)}%` : '…'}
            </p>
          </>
        ) : (
          <>
            <p>{t(state.phase === 'data' ? 'load.data' : state.phase === 'start' ? 'load.start' : 'load.signin')}</p>
            <progress aria-label={t('title')} />
          </>
        )}
      </div>
    </div>
  );
}
