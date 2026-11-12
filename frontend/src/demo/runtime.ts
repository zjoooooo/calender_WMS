// The real backend (backend/, unchanged) in this browser tab: PHP 8.3 compiled to WebAssembly by WordPress
// Playground's php-wasm. Calendar demo build only (§11.5); this module and php-wasm are a lazy chunk and the
// .wasm file is fetched on demand, so the first page load stays small.
// - JSPI where the browser has it (Chrome, Edge), Asyncify otherwise (Safari, Firefox). Neither needs
//   SharedArrayBuffer, so a plain static host works (no COOP/COEP headers).
// - The PHP files and the data folder live in php-wasm's in-memory filesystem: /wms/backend and /wms/data.
//   A virtual backend/config.local.php (the normal place for local overrides, §11.2) points data_dir there
//   and sets the visitor's time zone, so "today" is the visitor's date (useTimeZone(null) keeps the backend's
//   own zone, Asia/Singapore). No backend file is changed.
// - Requests run one at a time. After each one the data folder is compared with the last copy; when it
//   changed, onChange gets the new files (the caller saves them in IndexedDB).
import { loadPHPRuntime, PHP, PHPRequestHandler, type PHPRequest } from '@php-wasm/universal';
import { getPHPLoaderModule, jspi } from '@php-wasm/web-8-3';
import type { PhpHandler, PhpRequest, PhpResponse } from '../api';
import type { DemoFiles } from './storage';

const BACKEND_DIR = '/wms/backend';
const DATA_DIR = '/wms/data';

export interface Progress {
  loaded: number;
  total: number;
}

/** Downloads PHP 8.3 (reporting progress) and starts it. */
export async function loadPhp(onProgress: (p: Progress) => void): Promise<PHP> {
  if (!('setImmediate' in globalThis)) {
    (globalThis as any).setImmediate = (fn: () => void) => setTimeout(fn, 0); // as php-wasm's own web loader does
  }
  const mode = (await jspi()) ? 'jspi' : 'asyncify';
  const loader = await getPHPLoaderModule();
  const wasmBinary = await download(loader.dependencyFilename, loader.dependenciesTotalSize, onProgress);
  return new PHP(await loadPHPRuntime(loader, { wasmBinary, phpWasmAsyncMode: mode }));
}

async function download(url: string, size: number, onProgress: (p: Progress) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${url}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress({ loaded, total: size });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length; // bytes after any Content-Encoding, so they count up to the file's own size
    onProgress({ loaded, total: Math.max(size, loaded) });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

/**
 * The visitor's IANA zone name, as the browser reports it (it may be an older alias, e.g. Asia/Calcutta for
 * Asia/Kolkata; PHP knows both); null when the browser does not say.
 */
export function visitorTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return tz;
  } catch {
    /* no Intl time zone */
  }
  return null;
}

export interface InBrowserBackend {
  handle: PhpHandler;
  /** Replaces the whole data folder (files by path relative to it). */
  replaceData(files: DemoFiles): void;
  /** The time zone of the following requests; null: the backend's configured one. */
  useTimeZone(tz: string | null): void;
}

export function startBackend(
  php: PHP,
  opts: { backend: DemoFiles; data: DemoFiles; timeZone: string | null; onChange: (files: DemoFiles) => void },
): InBrowserBackend {
  writeTree(php, BACKEND_DIR, opts.backend);
  const useTimeZone = (tz: string | null) =>
    php.writeFile(
      `${BACKEND_DIR}/config.local.php`,
      "<?php\n// Written by the calendar demo (frontend/src/demo/runtime.ts) in php-wasm's in-memory filesystem.\n"
        + `$local = ['data_dir' => '${DATA_DIR}'];\n`
        // ALL_WITH_BC: also the older names that browsers still report (Chrome: Asia/Calcutta, Europe/Kiev).
        + (tz ? `if (in_array('${tz}', timezone_identifiers_list(DateTimeZone::ALL_WITH_BC), true)) {\n    $local['tz'] = '${tz}';\n}\n` : '')
        + 'return $local;\n',
    );
  useTimeZone(opts.timeZone);
  const putData = (files: DemoFiles) => {
    if (php.isDir(DATA_DIR)) php.rmdir(DATA_DIR, { recursive: true });
    php.mkdirTree(DATA_DIR);
    writeTree(php, DATA_DIR, files);
  };
  putData(opts.data);

  const handler = new PHPRequestHandler({
    php,
    documentRoot: `${BACKEND_DIR}/public`,
    absoluteUrl: 'http://localhost/',
    cookieStore: false,
    // As Caddy does in production (§11.4): every /api/* request runs public/index.php.
    rewriteRules: [{ match: /^\/api(\/.*)?$/, replacement: '/index.php' }],
  });

  let last = readTree(php, DATA_DIR);
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (req: PhpRequest): Promise<PhpResponse> => {
    const res = await handler.request({ ...req, method: req.method as PHPRequest['method'] });
    const now = readTree(php, DATA_DIR);
    if (!sameFiles(now, last)) {
      last = now;
      opts.onChange(now);
    }
    return res;
  };
  return {
    handle(req) {
      const p = queue.then(() => run(req));
      queue = p.catch(() => undefined);
      return p;
    },
    replaceData(files) {
      putData(files);
      last = readTree(php, DATA_DIR);
    },
    useTimeZone,
  };
}

function writeTree(php: PHP, root: string, files: DemoFiles): void {
  for (const [rel, bytes] of Object.entries(files)) {
    const path = `${root}/${rel}`;
    php.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    php.writeFile(path, bytes);
  }
}

/** Every file under root, except the lock file and temp files of an atomic write. */
function readTree(php: PHP, root: string, rel = '', out: DemoFiles = {}): DemoFiles {
  for (const name of php.listFiles(rel ? `${root}/${rel}` : root)) {
    const r = rel ? `${rel}/${name}` : name;
    if (php.isDir(`${root}/${r}`)) readTree(php, root, r, out);
    else if (r !== '.lock' && !name.endsWith('.tmp')) out[r] = php.readFileAsBuffer(`${root}/${r}`);
  }
  return out;
}

export function sameFiles(a: DemoFiles, b: DemoFiles): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
