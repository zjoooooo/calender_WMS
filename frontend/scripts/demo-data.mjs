#!/usr/bin/env node
// Demo data for the calendar demo on GitHub Pages (docs/Project.md §11.5), made by the REAL backend:
// a fresh data folder, backend/tools/init.php, the native `php -S` server on a free port, then
// scripts/seed-demo.mjs --with-runs (routes, customers, tasks and today's runs, so statuses and REL totals
// show). `vite build --mode demo` packs the result with the backend's PHP source (vite.config.ts).
//
//   node scripts/demo-data.mjs [--out demo-data] [--port <n>] [--if-missing]
//
// - The folder (default frontend/demo-data, git-ignored) is WIPED first; the data ends up in <out>/data and
//   the demo's sign-in in <out>/demo.json.
// - --port: the port for php -S (default: a free one). Env DEMO_DATA_PORT does the same.
// - --if-missing: do nothing when <out>/demo.json already exists (npm run build:demo uses it).
// - Needs php (8.3) on the PATH, or PHP_BINARY=<path to php>.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(FRONT, '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = path.resolve(FRONT, opt('out', 'demo-data'));
const DATA = path.join(OUT, 'data');
const PHP = process.env.PHP_BINARY || 'php';
// The demo signs in by itself with this account (src/demo/DemoApp.tsx reads it from the build).
const LOGIN = { username: 'admin', password: 'demo-pass-2026' };
// The driver demo (./driver/) signs in as this driver: seed-demo.mjs --with-runs gave Bala a route in progress
// and this password.
const DRIVER_LOGIN = { username: 'bala', password: 'driver-pass-2026!' };

if (args.includes('--if-missing') && fs.existsSync(path.join(OUT, 'demo.json'))) {
  console.log(`demo data: ${path.relative(FRONT, OUT)}/ already exists (run npm run demo:data to make it again)`);
  process.exit(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, server, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error(`php -S stopped (exit ${server.exitCode}):\n${server.output}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}:\n${server.output}`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, WMS_DATA_DIR: DATA };
  delete env.WMS_FAKE_NOW; // the demo runs on the real clock: "today" is the day of the build

  console.log(execFileSync(PHP, [path.join(ROOT, 'backend/tools/init.php')], { env, encoding: 'utf8' }).trim());

  const port = Number(opt('port', process.env.DEMO_DATA_PORT || 0)) || (await freePort());
  const api = `http://127.0.0.1:${port}`;
  const server = spawn(PHP, ['-S', `127.0.0.1:${port}`, path.join(ROOT, 'backend/public/index.php')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.output = '';
  server.stdout.on('data', (d) => (server.output += d));
  server.stderr.on('data', (d) => (server.output += d));
  try {
    await waitForHealth(`${api}/api/health`, server);
    const seed = spawn(process.execPath, [path.join(FRONT, 'scripts/seed-demo.mjs'), '--api', api, '--data-dir', DATA, '--new-password', LOGIN.password, '--with-runs'], {
      env,
      stdio: 'inherit',
    });
    const code = await new Promise((resolve) => seed.on('exit', resolve));
    if (code !== 0) throw new Error(`seed-demo.mjs failed (exit ${code})`);
    const meta = await (await fetch(`${api}/api/meta`, {
      headers: { Authorization: 'Bearer ' + (await (await fetch(`${api}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LOGIN) })).json()).data.token },
    })).json();
    const info = { built_at: new Date().toISOString(), today: meta.data.today, login: LOGIN, driver: DRIVER_LOGIN };
    fs.writeFileSync(path.join(OUT, 'demo.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`demo data: ${path.relative(FRONT, OUT)}/ (today ${info.today})`);
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
