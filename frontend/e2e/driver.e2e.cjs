// End-to-end test of the driver app (M6–M8 driver side) on a phone viewport (Pixel 7).
// Starts its own backend (php -S) and Vite, seeds demo data (scripts/seed-demo.mjs), drives two driver
// accounts in two browser contexts and checks every result through the office API, then stops both.
//
//   cd frontend && node e2e/driver.e2e.cjs        (or: npm run e2e:driver)
//
// Env (defaults): BACKEND_PORT=8282  FRONT_PORT=5282  WMS_DATA_DIR=/tmp/wms-test-driver
//                 E2E_SHOTS=<dir> to save screenshots   KEEP_DATA=1 to keep the data dir
//                 PWA=1 also builds the app (npm run build) and checks the offline start of the built app
//                 served by php -S (service worker + cached Today)
// The routes used are picked from the server's Today list, so the test works on any day with >= 2 routes.
/* eslint-disable no-console */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONT = path.join(ROOT, 'frontend');
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8282);
const FRONT_PORT = Number(process.env.FRONT_PORT || 5282);
const DATA = process.env.WMS_DATA_DIR || '/tmp/wms-test-driver';
const SHOTS = process.env.E2E_SHOTS || '';
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}`;
const ADMIN_PW = 'demo-pass-2026';
const SEED_DRIVER_PW = 'driver-pass-2026';
const DRIVER_PW = 'driver-pass-2026!';

const procs = [];
let failures = 0;
let passes = 0;
function check(cond, label, extra) {
  if (cond) {
    passes++;
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  p.stdout.on('data', (d) => (p.output += d));
  p.stderr.on('data', (d) => (p.output += d));
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for ' + url);
}
async function call(method, p, body, tok) {
  const r = await fetch(API + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = r.status === 204 ? { ok: true, data: null } : await r.json();
  if (!j.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error?.code}`);
  return j.data;
}
async function until(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

// A small valid PNG (a gradient) that the browser can decode and resize, like a camera photo.
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 128;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function signIn(page, username, password) {
  await page.goto(BASE + '/driver');
  await page.waitForURL('**/driver/login');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
}

async function drawSignature(page) {
  const c = page.locator('[data-testid=sig-canvas]');
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + 40 + i * 20, b.y + b.height / 2 + (i % 2 ? -30 : 30), { steps: 2 });
  await page.mouse.up();
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, WMS_DATA_DIR: DATA };
  execFileSync('php', [path.join(ROOT, 'backend/tools/init.php')], { env, stdio: 'pipe' });
  const appDir = path.join(ROOT, 'backend/public/app');
  fs.mkdirSync(appDir, { recursive: true });
  start('php', ['-S', `127.0.0.1:${BACKEND_PORT}`, '-t', appDir, path.join(ROOT, 'backend/public/index.php')], { cwd: ROOT, env });
  start(path.join(FRONT, 'node_modules/.bin/vite'), ['--port', String(FRONT_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: FRONT,
    env: { ...process.env, VITE_API_TARGET: API },
  });
  await waitFor(API + '/api/health');
  await waitFor(BASE + '/');

  console.log('seed demo data');
  // Asynchronous on purpose (see office.e2e.cjs): a synchronous child would stall php -S's log pipe.
  const seedOut = await new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(FRONT, 'scripts/seed-demo.mjs'), '--api', API, '--data-dir', DATA, '--new-password', ADMIN_PW]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('seed failed:\n' + out))));
  });
  console.log(seedOut.trim().split('\n').map((l) => '    ' + l).join('\n'));
  const admin = (await call('POST', '/login', { username: 'admin', password: ADMIN_PW })).token;
  // Bala's first-login password change is done through the API; Ali does it in the browser.
  let bala = await call('POST', '/login', { username: 'bala', password: SEED_DRIVER_PW });
  bala = (await call('POST', '/me/password', { old: SEED_DRIVER_PW, new: DRIVER_PW }, bala.token)).token;
  const meta = await call('GET', '/meta', null, admin);
  const today = meta.today;
  const dayList = await call('GET', '/driver/today', null, bala);
  const usable = dayList.routes.filter((r) => r.stops >= 4 && r.status === 'not_started');
  if (usable.length < 2) throw new Error('need two routes with >= 4 stops today, got ' + usable.map((r) => r.code));
  const [RA, RB] = usable;
  console.log(`today ${today}: route A = ${RA.code} (${RA.job}, ${RA.stops} stops), route B = ${RB.code} (${RB.job}, ${RB.stops} stops)`);

  const browser = await chromium.launch();
  const phone = { ...devices['Pixel 7'], locale: 'en-US', timezoneId: 'Asia/Singapore' };
  const ctxA = await browser.newContext(phone);
  const ctxB = await browser.newContext(phone);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const consoleErrors = [];
  for (const [who, pg] of [
    ['A', pageA],
    ['B', pageB],
  ]) {
    pg.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${who}: ${m.text()}`);
    });
    pg.on('pageerror', (e) => consoleErrors.push(`${who} pageerror: ${e.message}`));
  }

  try {
    // ---- 1. Sign in: Ali with the forced password change, Bala directly ------------------------------
    console.log('sign in');
    await signIn(pageA, 'ali', SEED_DRIVER_PW);
    await pageA.waitForURL('**/password');
    await pageA.fill('input[name=old]', SEED_DRIVER_PW);
    await pageA.fill('input[name=new]', DRIVER_PW);
    await pageA.fill('input[name=again]', DRIVER_PW);
    await pageA.click('button[type=submit]');
    await pageA.waitForURL(/\/driver$/);
    await pageA.waitForSelector(`button.jcard[data-code="${RA.code}"]`);
    check(true, 'Ali signs in, changes the first password and lands on Today');
    const theme = await pageA.evaluate(() => document.documentElement.dataset.app);
    check(theme === 'driver', 'driver high-contrast theme is on', theme);
    const tabText = await pageA.locator('.dtabs button').first().innerText();
    check(/Routes \(\d+\)/.test(tabText), 'Routes tab shows its count', tabText);
    const cardH = (await pageA.locator(`button.jcard[data-code="${RA.code}"]`).boundingBox()).height;
    check(cardH >= 72, 'route card is at least 72 px high', cardH);
    const noHScroll = await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(noHScroll, 'no horizontal scroll at phone width');

    await signIn(pageB, 'bala', DRIVER_PW);
    await pageB.waitForURL(/\/driver$/);
    await pageB.waitForSelector(`button.jcard[data-code="${RA.code}"]`);
    check(true, 'Bala signs in at /driver/login');
    await shot(pageA, '01-today');

    // ---- 2. Race: both open route A's preview, Ali confirms first ------------------------------------
    console.log('claim race');
    await pageA.click(`button.jcard[data-code="${RA.code}"]`);
    await pageB.click(`button.jcard[data-code="${RA.code}"]`);
    await pageA.waitForSelector('[data-testid=preview-stops]');
    await pageB.waitForSelector('[data-testid=preview-stops]');
    const stopRows = await pageA.locator('[data-testid=preview-stops] > div').count();
    check(stopRows === RA.stops, 'preview lists every stop read-only', { stopRows, expected: RA.stops });
    await pageA.selectOption('select[name=plate]', 'GBA1234X');
    await pageB.selectOption('select[name=plate]', 'SBA1234X');
    const btnH = (await pageA.locator('[data-testid=confirm]').boundingBox()).height;
    check(btnH >= 56, 'confirm button is at least 56 px high', btnH);
    await shot(pageA, '02-preview');
    await pageA.click('[data-testid=confirm]');
    await pageA.waitForSelector('[data-testid=run]');
    check(true, `Ali confirmed ${RA.code}: the run view opens`);
    await pageB.click('[data-testid=confirm]');
    const takenMsg = await pageB.locator('[data-testid=claim-error]').innerText({ timeout: 10000 });
    check(/Taken by Ali/.test(takenMsg), 'Bala confirming second sees "Taken by Ali"', takenMsg);
    await pageB.goto(BASE + '/driver');
    const cardB = pageB.locator(`section[data-section=active] button.jcard[data-code="${RA.code}"]`);
    await cardB.waitFor();
    check(await cardB.isDisabled(), "on Bala's Today the route is in Taken and cannot be tapped");
    const cardBText = await cardB.locator('[data-testid=status]').innerText();
    check(/Ali 0\/\d+/.test(cardBText), 'taken card shows "Ali 0/n"', cardBText);
    const opacity = await cardB.evaluate((el) => getComputedStyle(el).opacity);
    check(Number(opacity) < 1, 'taken card is greyed', opacity);
    await shot(pageB, '03-taken');

    // ---- 3. Ali records 2 stops: weight + photo + signature, then a heavy one --------------------------
    console.log('results');
    const prog0 = await pageA.locator('[data-testid=progress]').innerText();
    check(prog0.replace(/\s/g, '') === `0/${RA.stops}`, 'progress starts at 0 / n', prog0);
    await pageA.click('[data-testid=next-stop]');
    await pageA.waitForSelector('[data-testid=result-form]');
    const url1 = pageA.url();
    const cid1 = Number(/\/stop\/(\d+)/.exec(url1)[1]);
    const weightInput = pageA.locator('input[name="weight-REL"]');
    check((await weightInput.getAttribute('inputmode')) === 'decimal', 'weight field uses the decimal keypad');
    const fontPx = await weightInput.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(fontPx >= 28, 'weight field font is 28 px', fontPx);
    check((await pageA.locator('input[name^="weight-"]').count()) === 1, 'only the routable type (REL) is weighable on a route stop');
    // DRV-4: one weighable type: no [0] chip, and the empty / 0 hints point to Not collected → No waste.
    check((await pageA.locator('[data-testid=result-form] button.zero').count()) === 0, 'a REL-only stop has no [0] chip (0 alone is refused)');
    await pageA.click('[data-testid=save-collected]');
    const emptyErr = await pageA.locator('.dfield .err').first().innerText();
    check(/Not collected/.test(emptyErr) && !/tap 0/.test(emptyErr), 'the empty-weight hint points to "Not collected… → No waste"', emptyErr);
    await weightInput.fill('0');
    await pageA.click('[data-testid=save-collected]');
    const zeroErr = await pageA.locator('.form-err').innerText();
    check(/Not collected/.test(zeroErr), 'a 0 weight says what to do instead', zeroErr);
    await weightInput.fill('120,5');
    await pageA.setInputFiles('[data-testid=photo-input]', { name: 'photo.png', mimeType: 'image/png', buffer: makePng(400, 300) });
    await pageA.waitForSelector('[data-testid=photos] img');
    check(true, 'photo resized on the phone and shown as a thumbnail');
    await pageA.click('text=Signature');
    await pageA.waitForSelector('[data-testid=sig-canvas]');
    await drawSignature(pageA);
    await pageA.click('text=Save signature');
    await pageA.waitForSelector('[data-testid=signature] img');
    check(true, 'signature captured on the full-screen pad');
    await shot(pageA, '04-form');
    await pageA.click('[data-testid=save-collected]');
    await pageA.waitForURL((u) => /\/stop\/\d+$/.test(u.pathname) && !u.pathname.endsWith('/' + cid1));
    const cid2 = Number(/\/stop\/(\d+)/.exec(pageA.url())[1]);
    check(cid2 !== cid1, 'after saving, the next pending stop opens');
    await pageA.fill('input[name="weight-REL"]', '1250,5');
    await pageA.click('[data-testid=save-collected]');
    const overText = await pageA.locator('[data-testid=over-sheet]').innerText();
    check(/1,250\.5 kg, correct\?/.test(overText), 'a weight above confirm_over asks "1,250.5 kg, correct?"', overText);
    await pageA.click('[data-testid=over-sheet] >> text=Yes, save');
    await pageA.waitForURL((u) => /\/stop\/\d+$/.test(u.pathname) && !u.pathname.endsWith('/' + cid2));
    const synced = await until(async () => /Synced/.test(await pageA.locator('[data-testid=sync-pill]').innerText()));
    check(synced, 'the outbox sends both stops ("Synced")');

    const runA = await until(async () => {
      const r = await call('GET', `/runs/${today}/${RA.job}`, null, admin);
      return r.visits[cid1] && r.visits[cid2] ? r : null;
    });
    const v1 = runA?.visits?.[cid1];
    const v2 = runA?.visits?.[cid2];
    check(v1 && v1.outcome === 'collected' && v1.weights.REL === 120.5, 'stop 1 recorded: REL 120.5 kg ("," accepted)', v1 && v1.weights);
    check(v1 && v1.photos.length === 1 && /^files\/[0-9a-f]{2}\/[0-9a-f-]{36}\.jpg$/.test(v1.photos[0]), 'stop 1 has its photo (stored as jpg)', v1 && v1.photos);
    check(v1 && /\.png$/.test(v1.signature || ''), 'stop 1 has the signature (png)', v1 && v1.signature);
    check(v2 && v2.weights.REL === 1250.5, 'stop 2 recorded: REL 1250.5 kg', v2 && v2.weights);
    const users = await call('GET', '/users', null, admin);
    const aliId = users.find((u) => u.username === 'ali').id;
    check(v1 && v1.driver_id === aliId && v2 && v2.driver_id === aliId, 'both visits are under Ali');
    if (v1) {
      const name = v1.photos[0].split('/').pop();
      const fr = await fetch(`${API}/api/files/${name}`, { headers: { Authorization: 'Bearer ' + admin } });
      const bytes = Buffer.from(await fr.arrayBuffer());
      check(fr.status === 200 && bytes[0] === 0xff && bytes[1] === 0xd8, 'the photo file was uploaded as a real JPEG', fr.status);
    }

    // ---- 4. Switch route midway: the rest of A goes back to Needs driver -----------------------------
    console.log('switch route');
    await pageA.goto(`${BASE}/driver/job/${today}/${RA.job}`);
    await pageA.waitForSelector('[data-testid=run]');
    const prog2 = await pageA.locator('[data-testid=progress]').innerText();
    check(prog2.replace(/\s/g, '') === `2/${RA.stops}`, 'progress shows 2 / n', prog2);
    await pageA.click('text=More…');
    await pageA.click('[data-testid=run-menu] >> text=Switch route');
    await pageA.waitForURL('**/driver?switch=1');
    await pageA.click(`button.jcard[data-code="${RB.code}"]`);
    await pageA.waitForSelector('[data-testid=preview-stops]');
    const confirmLabel = await pageA.locator('[data-testid=confirm]').innerText();
    check(/Switch to this route/.test(confirmLabel), 'the preview offers "Switch to this route" while holding A', confirmLabel);
    check((await pageA.locator('select[name=plate]').inputValue()) === 'GBA1234X', "the plate is pre-filled with this phone's last plate");
    await pageA.click('[data-testid=confirm]');
    const sheet = pageA.locator('[data-testid=switch-sheet]');
    await sheet.waitFor();
    const sheetText = await sheet.innerText();
    check(sheetText.includes(`Leave ${RA.code}?`) && sheetText.includes(`2 stops done, ${RA.stops - 2} left`), 'the Switch sheet explains what happens', sheetText);
    await shot(pageA, '05-switch');
    await sheet.locator('button', { hasText: 'Switch to' }).click();
    await pageA.waitForSelector('[data-testid=run]');
    const headCode = await pageA.locator('.rhead .jcode').innerText();
    check(headCode.includes(RB.code), `Ali now runs ${RB.code}`, headCode);

    const listB = await call('GET', '/driver/today', null, bala);
    const cardA = listB.routes.find((r) => r.job === RA.job);
    check(cardA && cardA.status === 'open' && cardA.left_by === 'Ali' && cardA.pending === RA.stops - 2, 'API: route A is open ("needs driver"), left by Ali, n-2 pending', cardA);
    const runA2 = await call('GET', `/runs/${today}/${RA.job}`, null, admin);
    check(runA2.visits[cid1].driver_id === aliId && runA2.holds[0].end === 'switched', "Ali's 2 stops stay under his name; the hold ended 'switched'", runA2.holds);
    await pageB.reload();
    const openCard = pageB.locator(`section[data-section=open] button.jcard[data-code="${RA.code}"]`);
    await openCard.waitFor({ timeout: 10000 });
    const openText = await openCard.locator('[data-testid=status]').innerText();
    check(/Needs driver 2\/\d+ · left by Ali/.test(openText), `Bala sees ${RA.code} under Needs driver ("left by Ali")`, openText);
    check(!(await openCard.isDisabled()), 'a Needs-driver route can be tapped by another driver');
    await shot(pageB, '06-needs-driver');

    // ---- 5. Offline: a stop with a photo goes to the outbox, then exactly once on reconnect -----------
    console.log('offline');
    await ctxA.setOffline(true);
    await pageA.click('[data-testid=next-stop]');
    await pageA.waitForSelector('[data-testid=result-form]');
    const cidOff = Number(/\/stop\/(\d+)/.exec(pageA.url())[1]);
    await pageA.fill('input[name="weight-REL"]', '77');
    await pageA.setInputFiles('[data-testid=photo-input]', { name: 'p2.png', mimeType: 'image/png', buffer: makePng(320, 240) });
    await pageA.waitForSelector('[data-testid=photos] img');
    await pageA.click('[data-testid=save-collected]');
    await pageA.waitForURL((u) => !u.pathname.endsWith('/' + cidOff));
    await pageA.locator('.drv-top .back').click();
    await pageA.waitForSelector('[data-testid=run]');
    const offRow = pageA.locator(`[data-testid=done-list] [data-cid="${cidOff}"]`);
    const offRowText = await offRow.innerText();
    check(/Not sent yet/.test(offRowText) && /77/.test(offRowText), 'the run view shows the stop as done with "Not sent yet"', offRowText);
    const pillOff = await pageA.locator('[data-testid=sync-pill]').innerText();
    check(/Offline/.test(pillOff), 'sync pill says Offline', pillOff);
    const progOff = await pageA.locator('[data-testid=progress]').innerText();
    check(progOff.replace(/\s/g, '') === `1/${RB.stops}`, 'progress counts the unsent stop', progOff);
    const finishOrNext = await pageA.locator('.drv-bar .dbtn').first().innerText();
    check(/Next stop/.test(finishOrNext), 'the next stop is still offered offline', finishOrNext);
    await shot(pageA, '07-offline');
    const before = await call('GET', `/runs/${today}/${RB.job}`, null, admin);
    check(!before.visits[cidOff], 'the server has nothing yet');

    // The first PUT reaches the server but its response is "lost"; the retry must be a replay.
    const putOps = [];
    let lost = false;
    await pageA.route('**/api/driver/runs/**/stops/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PUT') putOps.push(JSON.parse(req.postData() || '{}').op_id);
      if (req.method() === 'PUT' && !lost) {
        lost = true;
        await route.fetch(); // the server applies it ...
        await route.abort('failed'); // ... but the phone never hears back
        return;
      }
      await route.continue();
    });
    await ctxA.setOffline(false);
    await until(async () => putOps.length >= 1, 15000);
    await pageA.evaluate(() => window.dispatchEvent(new Event('focus'))); // a flush also starts on focus
    const okSync = await until(async () => /Synced/.test(await pageA.locator('[data-testid=sync-pill]').innerText()), 20000);
    check(okSync, 'after reconnecting the outbox empties ("Synced")');
    check(putOps.length >= 2 && new Set(putOps).size === 1, 'the retry resent the same op_id', putOps);
    const after = await call('GET', `/runs/${today}/${RB.job}`, null, admin);
    const vo = after.visits[cidOff];
    check(vo && vo.weights.REL === 77 && vo.rev === 1, 'the offline stop is recorded once (rev 1, REL 77)', vo && { rev: vo.rev, w: vo.weights });
    check(vo && vo.ops.length === 1 && vo.history.length === 0, 'exactly once: one op, no history', vo && { ops: vo.ops, h: vo.history.length });
    check(vo && vo.photos.length === 1, 'its photo was uploaded first and is referenced', vo && vo.photos);
    check(vo && !(vo.flags || []).includes('LATE'), 'not flagged LATE (captured during the hold, same day)', vo && vo.flags);
    await pageA.unroute('**/api/driver/runs/**/stops/**');
    const rowText = await until(async () => {
      const x = await offRow.innerText();
      return /Not sent yet/.test(x) ? null : x;
    });
    check(rowText && !/Not sent yet/.test(rowText), 'the cloud mark goes away once acknowledged', rowText);
    await shot(pageA, '08-synced');

    // ---- 6. Bala picks up the rest of route A from Needs driver ----------------------------------------
    console.log('pick up');
    await openCard.click();
    await pageB.waitForSelector('[data-testid=preview-stops]');
    await pageB.selectOption('select[name=plate]', 'SBA1234X');
    await pageB.click('[data-testid=confirm]');
    await pageB.waitForSelector('[data-testid=run]');
    const progB = await pageB.locator('[data-testid=progress]').innerText();
    check(progB.replace(/\s/g, '') === `2/${RA.stops}`, 'Bala continues route A at 2 / n', progB);
    const doneRows = await pageB.locator('[data-testid=done-list] .drow').count();
    check(doneRows === 2, "Ali's two stops are in Bala's done list", doneRows);
    const aliRowLink = await pageB.locator(`[data-testid=done-list] a.drow[data-cid="${cid1}"]`).count();
    check(aliRowLink === 0, "Bala cannot open Ali's results for correction");

    // ---- 6b. A task while holding a route (tasks never conflict, R23) -----------------------------------
    const task = dayList.tasks.find((x) => x.status === 'not_started');
    if (task) {
      console.log('task');
      await pageB.goto(BASE + '/driver');
      await pageB.locator('.dtabs button').nth(1).click();
      await pageB.click(`button.jcard[data-job="${task.job}"]`);
      await pageB.waitForSelector('[data-testid=confirm]');
      check((await pageB.locator('select[name=plate]').inputValue()) === 'SBA1234X', "the task's plate is pre-filled with the plate of the driver's route");
      await pageB.click('[data-testid=confirm]');
      await pageB.waitForSelector('[data-testid=result-form]');
      const fields = await pageB.locator('input[name^="weight-"]').evaluateAll((els) => els.map((e) => e.name));
      check(fields.length === 1 && fields[0] === `weight-${task.waste_type}`, 'the task form has one weight field, for the task type', fields);
      await pageB.fill(`input[name="weight-${task.waste_type}"]`, '300');
      await pageB.click('[data-testid=save-collected]');
      await pageB.waitForURL(/\/driver$/);
      const tv = await until(async () => (await call('GET', `/runs/${today}/${task.job}`, null, admin)).visits[task.customer.id]);
      check(tv && tv.outcome === 'collected' && tv.weights[task.waste_type] === 300, 'task result recorded; back on Today', tv && tv.weights);
      const mr = (await call('GET', '/driver/today', null, bala)).my_route;
      check(mr && mr.job === RA.job, 'Bala still holds route A while doing the task', mr);
    } else {
      console.log('  (no task today: task step skipped)');
    }

    // ---- 6c. Leave sheet: mark the rest not collected -> S6 Route done ------------------------------------
    console.log('leave: mark all not collected');
    await pageB.goto(`${BASE}/driver/job/${today}/${RA.job}`);
    await pageB.waitForSelector('[data-testid=run]');
    await pageB.click('text=More…');
    await pageB.click('[data-testid=run-menu] >> text=Leave route…');
    const ls = pageB.locator('[data-testid=leave-sheet]');
    await ls.waitFor();
    check((await ls.innerText()).includes(`${RA.stops - 2} stops not done`), 'the Leave sheet counts the stops not done');
    await ls.locator('button', { hasText: 'Mark all not collected' }).click();
    await ls.locator('button', { hasText: 'Closed' }).click();
    await ls.locator('button', { hasText: /^Mark \d+ stops not collected$/ }).click();
    await pageB.waitForSelector('[data-testid=route-done]');
    const doneText = await pageB.locator('[data-testid=route-done]').innerText();
    check(doneText.includes(`2 collected, ${RA.stops - 2} not collected, ${RA.stops} stops`), 'S6 shows collected, missed and totals', doneText);
    const runA3 = await call('GET', `/runs/${today}/${RA.job}`, null, admin);
    const missedClosed = Object.values(runA3.visits).filter((v) => v.outcome === 'missed' && v.reason === 'closed').length;
    check(runA3.status === 'done' && missedClosed === RA.stops - 2, 'API: route A done, the rest missed "closed"', { status: runA3.status, missedClosed });
    await shot(pageB, '10-route-done');

    // ---- 6d. A short route to the end: [Finish route] --------------------------------------------------
    const small = dayList.routes.find((r) => r.stops <= 3 && r.job !== RA.job && r.job !== RB.job);
    if (small) {
      console.log(`finish (${small.code})`);
      await pageB.goto(`${BASE}/driver/job/${today}/${small.job}`);
      await pageB.waitForSelector('[data-testid=confirm]');
      await pageB.click('[data-testid=confirm]');
      await pageB.waitForSelector('[data-testid=run]');
      await pageB.click('[data-testid=next-stop]');
      for (let i = 0; i < small.stops; i++) {
        await pageB.waitForSelector('[data-testid=result-form]');
        const before = pageB.url();
        await pageB.fill('input[name="weight-REL"]', String(10 + i));
        await pageB.click('[data-testid=save-collected]');
        await pageB.waitForURL((u) => u.href !== before);
      }
      await pageB.waitForSelector('[data-testid=run]');
      const fin = pageB.locator('[data-testid=finish]');
      const finLabel = await until(async () => ((await fin.innerText()) === 'Finish route' ? 'ok' : null));
      check(!!finLabel, '[Finish route] appears when nothing is pending and everything is sent');
      await fin.click();
      await pageB.waitForSelector('[data-testid=route-done]');
      const runS = await call('GET', `/runs/${today}/${small.job}`, null, admin);
      check(runS.status === 'done' && runS.holds[runS.holds.length - 1].end === 'finished' && runS.holder === null, 'API: the route is done and the hold ended "finished"', { status: runS.status, holds: runS.holds });
    }

    // ---- 7. Correction of an own result: Ali opens stop 1 of route B from Done and changes it ------------
    console.log('correction');
    await pageA.click(`[data-testid=done-list] a.drow[data-cid="${cidOff}"]`);
    await pageA.waitForSelector('[data-testid=result-form]');
    check((await pageA.locator('input[name="weight-REL"]').inputValue()) === '77', 'the form reopens with the saved value');
    check((await pageA.locator('[data-testid=save-collected]').innerText()).includes('Save correction'), 'it offers Save correction and Undo');
    await pageA.fill('input[name="weight-REL"]', '78.5');
    await pageA.fill('textarea[name=note]', 'evidence note');
    // DRV-2: the send fails (no network for the PUT), then the stop is opened by a fresh page load.
    await pageA.route('**/api/driver/runs/**/stops/**', (route) => (route.request().method() === 'PUT' ? route.abort('failed') : route.continue()));
    await pageA.click('[data-testid=save-collected]');
    await pageA.waitForURL((u) => !u.pathname.endsWith('/' + cidOff));
    const stopUrl = `${BASE}/driver/job/${today}/${RB.job}/stop/${cidOff}`;
    await pageA.goto(stopUrl);
    await pageA.waitForSelector('[data-testid=result-form] input[name="weight-REL"]');
    const reW = await pageA.locator('input[name="weight-REL"]').inputValue();
    const reNote = await pageA.locator('textarea[name=note]').inputValue();
    const reBanner = await pageA.locator('.dban.warn', { hasText: 'You are correcting a saved result.' }).count();
    check(reW === '78.5' && reNote === 'evidence note' && reBanner === 1, 'a fresh load of an unsent stop opens with its queued values and the "correcting" banner', { reW, reNote, reBanner });
    await pageA.unroute('**/api/driver/runs/**/stops/**');
    await pageA.evaluate(() => window.dispatchEvent(new Event('focus'))); // a flush starts on focus
    const corrected = await until(async () => {
      const r = await call('GET', `/runs/${today}/${RB.job}`, null, admin);
      return r.visits[cidOff]?.rev === 2 ? r.visits[cidOff] : null;
    });
    check(corrected && corrected.weights.REL === 78.5 && corrected.history.length === 1, 'correction stored as rev 2 with history', corrected && { w: corrected.weights, h: corrected.history.length });
    check(corrected && corrected.note === 'evidence note', 'its note reached the server too', corrected && corrected.note);

    // ---- 7b. Office actions reach the phone (§8.2) -------------------------------------------------------
    console.log('office actions');
    const otcCust = (await call('GET', '/customers?type=OTC', null, admin)).find((c) => c.waste_types.length === 1 && c.waste_types[0] === 'OTC');
    if (otcCust) {
      await call('POST', '/tasks', { waste_type: 'OTC', customer_id: otcCust.id, date: today, note: 'Called the office' }, admin);
      await pageB.goto(BASE + '/driver');
      const banner = await pageB.locator('[data-testid=new-today]').innerText({ timeout: 10000 });
      check(banner.includes(otcCust.name), '"New today" banner for a task the office just created', banner);
      // DRV-6: a new task someone else already took is not announced.
      const other = (await call('GET', '/customers?type=OTC', null, admin)).find((c) => c.id !== otcCust.id && c.waste_types.includes('OTC'));
      if (other) {
        const tk = await call('POST', '/tasks', { waste_type: 'OTC', customer_id: other.id, date: today, note: 'taken at once' }, admin);
        const aliTok = (await call('POST', '/login', { username: 'ali', password: DRIVER_PW })).token;
        await call('POST', `/driver/runs/${today}/t${tk.id}/claim`, { vehicle_no: 'GBA1234X' }, aliTok);
        await pageB.goto(BASE + '/driver');
        await pageB.locator(`[data-testid=new-today]`).waitFor();
        const banner2 = await pageB.locator('[data-testid=new-today]').innerText();
        check(banner2.includes(otcCust.name) && !banner2.includes(other.name), '"New today" leaves out a task another driver already took', banner2);
      }
    }
    await pageA.goto(`${BASE}/driver/job/${today}/${RB.job}`);
    await pageA.waitForSelector('[data-testid=run]');
    // DRV-1: Ali is on a stop form (not the run view) when the office takes the route back.
    await pageA.click('[data-testid=next-stop]');
    await pageA.waitForSelector('[data-testid=result-form]');
    await call('POST', `/runs/${today}/${RB.job}/release`, { mark_missed: false }, admin);
    await pageA.waitForTimeout(5500); // past the 5 s staleTime, then a visibility change refetches (else the 30 s poll)
    await pageA.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await pageA.waitForURL(/\/driver$/, { timeout: 40000 });
    const tookBack = await pageA.locator('.toast').innerText().catch(() => '');
    check(/Office took back/.test(tookBack), `office Release while on a stop form: Ali's phone returns to Today ("Office took back ${RB.code}")`, tookBack);

    // ---- 8. zh switch keeps working on the phone ------------------------------------------------------
    await pageB.goto(BASE + '/driver');
    await pageB.click('text=Menu');
    await pageB.click('.dsheet >> text=中文');
    await pageB.keyboard.press('Escape');
    const zhTab = await until(async () => {
      const x = await pageB.locator('.dtabs button').first().innerText();
      return /路线/.test(x) ? x : null;
    });
    check(!!zhTab, 'language switch to 中文 on the phone', zhTab);
    await shot(pageB, '09-zh');

    // ---- 9. A language tapped on the sign-in page carries over (DRV-8; Chong's account is English) -----
    console.log('sign-in language');
    const ctxC = await browser.newContext(phone);
    const pageC = await ctxC.newPage();
    await pageC.goto(BASE + '/driver/login');
    await pageC.getByRole('button', { name: '中文' }).click();
    await pageC.fill('input[name=username]', 'chong');
    await pageC.fill('input[name=password]', SEED_DRIVER_PW);
    await pageC.click('button[type=submit]');
    await pageC.waitForURL('**/password');
    const pwHead = await pageC.locator('h1, h2').first().innerText();
    check(/设置新密码/.test(pwHead), 'the forced password page stays in 中文', pwHead);
    await pageC.fill('input[name=old]', SEED_DRIVER_PW);
    await pageC.fill('input[name=new]', DRIVER_PW);
    await pageC.fill('input[name=again]', DRIVER_PW);
    await pageC.click('button[type=submit]');
    await pageC.waitForURL(/\/driver$/);
    const tabC = await until(async () => {
      const x = await pageC.locator('.dtabs button').first().innerText();
      return /路线/.test(x) ? x : null;
    });
    check(!!tabC, 'Today is in 中文 after the sign-in', tabC);
    const chong = await until(async () => (await call('GET', '/users', null, admin)).find((u) => u.username === 'chong' && u.lang === 'zh'));
    check(!!chong, 'the choice is saved on the user (lang zh)');
    await ctxC.close();

    const unexpected = consoleErrors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|status of 409|status of 4\d\d/.test(e));
    check(unexpected.length === 0, 'no unexpected console errors', unexpected);
  } finally {
    await browser.close();
  }

  if (process.env.PWA === '1') await pwaCheck(admin, today);
}

/** The built app (service worker) opens with zero signal and shows the cached Today (§7.7). */
async function pwaCheck() {
  console.log('pwa: build and offline start');
  await new Promise((resolve, reject) => {
    const p = spawn('npm', ['run', 'build'], { cwd: FRONT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('build failed:\n' + out))));
  });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', timezoneId: 'Asia/Singapore', serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    await page.goto(API + '/driver');
    await page.waitForURL('**/driver/login');
    await page.fill('input[name=username]', 'bala');
    await page.fill('input[name=password]', DRIVER_PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('button.jcard');
    const swReady = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    });
    check(swReady, 'pwa: the service worker is active');
    await page.reload();
    await page.waitForSelector('button.jcard');
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check(controlled, 'pwa: the page is controlled by the service worker');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('button.jcard', { timeout: 15000 });
    const pill = await page.locator('[data-testid=sync-pill]').innerText();
    check(/Offline · data from|离线 · 数据来自/.test(pill), 'pwa: opened with zero signal, cached Today shown with its data time', pill);
    const apiCached = await page.evaluate(async () => {
      const names = await caches.keys();
      for (const n of names) {
        const c = await caches.open(n);
        for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith('/api/')) return req.url;
      }
      return null;
    });
    check(apiCached === null, 'pwa: no /api response is in the service-worker caches', apiCached);
    await shot(page, '10-pwa-offline');
    await ctx.close();
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
    for (const p of procs) if (p.output && /error/i.test(p.output)) console.error(p.output.slice(-3000));
  })
  .finally(() => {
    stopAll();
    if (!process.env.KEEP_DATA) fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
