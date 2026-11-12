// Vite plugin of the calendar demo build only (`vite build --mode demo`, docs/Project.md §11.5).
// - `virtual:wms-demo-bundle`: one JSON asset with the backend's PHP source (bootstrap.php, config.php,
//   public/index.php, src/, seed/) and the demo data made by scripts/demo-data.mjs. src/demo/runtime.ts
//   writes both into php-wasm's virtual filesystem at the first start.
// - Its `version` is a hash of that PHP source and of the data: a copy of the data that a visitor's browser
//   saved belongs to one deploy. After a deploy with other code or other data (every rebuild makes new data,
//   the weekly one too, so that its runs are recent), the demo starts again from the bundled data.
// - php-wasm's PHP binary (`import url from './8_3_33/php_8_3.wasm'`) is emitted as a file and imported as its
//   URL; its optional intl extension (13 MB, never loaded here) is not emitted.
// - index.html gets a plain "loading" line, shown until the app's script runs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const FRONT = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(FRONT, '../backend');
/** The backend files the API needs at run time (no tools/, tests/ or data/). */
const BACKEND_PARTS = ['bootstrap.php', 'config.php', 'public/index.php', 'src', 'seed'];
const VIRTUAL = 'virtual:wms-demo-bundle';
const DEV_URL = '/@wms-demo-bundle.json';

type FileText = string | { b64: string };

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** UTF-8 text as a string, anything else (a photo) as base64. */
function encode(buf: Buffer): FileText {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : { b64: buf.toString('base64') };
}

/** dataRoot: the folder of scripts/demo-data.mjs (relative to frontend/), with demo.json and data/. */
export function makeDemoBundle(dataRootArg: string) {
  const dataRoot = path.resolve(FRONT, dataRootArg);
  const infoFile = path.join(dataRoot, 'demo.json');
  if (!fs.existsSync(infoFile)) {
    throw new Error(`No demo data in ${dataRoot}: run "npm run demo:data" first (it needs php on the PATH).`);
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const backend: Record<string, FileText> = {};
  const hash = createHash('sha256');
  for (const part of BACKEND_PARTS) {
    const full = path.join(BACKEND, part);
    const files = fs.statSync(full).isDirectory() ? listFiles(full).map((f) => `${part}/${f}`) : [part];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(BACKEND, f));
      backend[f] = encode(buf);
      hash.update(f).update('\0').update(buf).update('\0');
    }
  }
  const data: Record<string, FileText> = {};
  const dataDir = path.join(dataRoot, 'data');
  for (const f of listFiles(dataDir)) {
    // .lock is made again by flock(); temp files are leftovers of an interrupted write.
    if (f === '.lock' || f.endsWith('.tmp') || f === 'initial-admin.txt') continue;
    const buf = fs.readFileSync(path.join(dataDir, f));
    data[f] = encode(buf);
    hash.update(`data/${f}`).update('\0').update(buf).update('\0');
  }
  return {
    version: hash.digest('hex').slice(0, 16),
    built_at: info.built_at as string,
    today: info.today as string,
    login: info.login as { username: string; password: string },
    backend,
    data,
  };
}

export function wmsDemo(dataRoot: string): Plugin {
  let isBuild = false;
  return {
    name: 'wms-demo',
    enforce: 'pre',
    configResolved(c) {
      isBuild = c.command === 'build';
    },
    resolveId(id, importer) {
      if (id === VIRTUAL) return '\0' + VIRTUAL;
      if (/\/extensions\/intl\/intl\.so\?url$/.test(id)) return '\0wms-no-intl';
      if (id.endsWith('.wasm') && importer?.includes('@php-wasm')) return this.resolve(id + '?url', importer, { skipSelf: true });
      return null;
    },
    load(id) {
      if (id === '\0wms-no-intl') return 'export default "";';
      if (id !== '\0' + VIRTUAL) return null;
      const bundle = makeDemoBundle(dataRoot);
      const json = JSON.stringify(bundle);
      const meta = JSON.stringify({ version: bundle.version, size: Buffer.byteLength(json) });
      if (!isBuild) return `export const bundleUrl = ${JSON.stringify(DEV_URL)};\nexport const bundleMeta = ${meta};\n`;
      const ref = this.emitFile({ type: 'asset', name: 'wms-demo.json', source: json });
      return `export const bundleUrl = import.meta.ROLLUP_FILE_URL_${ref};\nexport const bundleMeta = ${meta};\n`;
    },
    configureServer(server) {
      // `vite --mode demo` (development): the bundle is made again on each request.
      server.middlewares.use(DEV_URL, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(makeDemoBundle(dataRoot)));
      });
    },
    transformIndexHtml(html) {
      return html.replace(
        '<div id="root"></div>',
        '<div id="root"><p style="font:15px system-ui,sans-serif;text-align:center;margin-top:30vh;color:#5b6573">正在加载演示… · Loading the demo…</p></div>',
      );
    },
  };
}
