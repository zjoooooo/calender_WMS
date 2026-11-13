// End-to-end test of the calendar demo build for GitHub Pages (§11.5): frontend/dist-demo, where the real
// backend runs in the browser (php-wasm). Serves dist-demo with a tiny static server that sends no special
// headers (no COOP/COEP, like GitHub Pages) and knows nothing of the app's routes, under the Pages sub-path
// /calender_WMS/ and under a random prefix, and drives Chromium with Playwright:
// - it opens with no sign-in on the month view with routes; >4 collapse / expand; the week view;
// - a real edit round trip: a new route with two customers, reordered by drag "and all following" on a later
//   date (which splits it), a customer removed on one date, the route deleted; reload keeps the edits and
//   "Reset demo data" restores the original data;
// - the zh / en switch; no request ever goes to an /api URL; no console errors; no horizontal overflow at
//   1280 and 1440, and a usable page at phone width; a visitor west of Singapore; storage blocked; a browser
//   without JSPI (php-wasm's Asyncify build);
// - only the visitor's changes are saved (opening the demo saves nothing); two tabs never overwrite each
//   other's saved changes silently; a browser that reports an older zone name (Pacific/Truk); the error screen
//   when the demo's own code does not load;
// - the driver app demo one folder down (./driver/): no sign-in, signed in as the demo driver, a free
//   submission end to end, shared saved data with the office demo, the links between the two, Reset.
//
//   cd frontend && npm run demo:data && npm run build:demo && node e2e/demo.e2e.cjs     (or: npm run e2e:demo)
//
// Env (defaults): DEMO_PORT=5826  DEMO_PORT2=5827   E2E_SHOTS=<dir> to save screenshots
// The API checks call the backend in the page (window.__wmsDemo.api), never a server.
/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const FRONT = path.resolve(__dirname, '..');
const DIST = path.join(FRONT, 'dist-demo');
const PORT = Number(process.env.DEMO_PORT || 5826);
const PORT2 = Number(process.env.DEMO_PORT2 || 5827);
const SHOTS = process.env.E2E_SHOTS || '';
const PAGES_PREFIX = '/calender_WMS/';
const RANDOM_PREFIX = `/x${Math.random().toString(36).slice(2, 8)}/demo/`;

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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** A plain static host: files under `prefix`, 404 for everything else (no SPA fallback, no extra headers). */
function serve(port, prefix) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(prefix)) return void res.writeHead(404).end('Not found');
    p = p.slice(prefix.length) || 'index.html';
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const api = (page, method, p, body) => page.evaluate(([m, x, b]) => window.__wmsDemo.api(m, x, b), [method, p, body]);
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function poll(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Opens the demo (url) or reloads the page (no url) and waits for a usable month view; returns the ms it took. */
async function boot(page, url) {
  const t0 = Date.now();
  if (url) await page.goto(url);
  else await page.reload();
  await page.locator('.month .mline').first().waitFor({ timeout: 120000 });
  await page.locator('.demo-bar').waitFor();
  return Date.now() - t0;
}
const saved = (page) => poll(() => page.evaluate(() => document.documentElement.dataset.demoSave === 'saved'));
const saveState = (page) => page.evaluate(() => document.documentElement.dataset.demoSave);
/** The copy saved in this browser (IndexedDB wms-demo / kv / data) as { version, rev }, or null. */
const storedCopy = (page) =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'wms-demo')) return null; // never create it here
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('wms-demo');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('kv')) return null;
      const v = await new Promise((resolve) => {
        const g = db.transaction('kv').objectStore('kv').get('data');
        g.onsuccess = () => resolve(g.result);
      });
      return v ? { version: v.version, rev: v.rev } : null;
    } finally {
      db.close();
    }
  });
async function dragTo(page, from, to) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 8, { steps: 4 }); // > 5 px: the drag starts
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 4, { steps: 25 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400); // drop animation
}

/** Every page of a context: console errors, page errors and the URL of every request. */
function watch(context, log) {
  context.on('page', (page) => attach(page, log));
  for (const p of context.pages()) attach(p, log);
}
function attach(page, log) {
  page.on('console', (m) => m.type() === 'error' && log.errors.push(m.text()));
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('request', (r) => log.requests.push(r.url()));
  page.on('requestfinished', async (r) => {
    const s = await r.sizes().catch(() => null);
    if (s) log.bytes += s.responseBodySize;
  });
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('frontend/dist-demo is missing: run "npm run demo:data" and "npm run build:demo" first');
    process.exit(2);
  }
  const bundleFile = fs.readdirSync(path.join(DIST, 'assets')).find((f) => /^wms-demo-.*\.json$/.test(f));
  const builtToday = JSON.parse(fs.readFileSync(path.join(DIST, 'assets', bundleFile), 'utf8')).today;
  const servers = [await serve(PORT, PAGES_PREFIX), await serve(PORT2, RANDOM_PREFIX)];
  const BASE = `http://127.0.0.1:${PORT}${PAGES_PREFIX}`;
  const BASE2 = `http://127.0.0.1:${PORT2}${RANDOM_PREFIX}`;
  const browser = await chromium.launch();
  const log = { errors: [], requests: [], bytes: 0 };
  try {
    // ---- A: GitHub Pages sub-path, a visitor in Singapore -----------------------------------------
    console.log(`A. ${BASE} (Asia/Singapore, 1440×1000)`);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    watch(ctx, log);
    const page = await ctx.newPage();
    const coldMs = await boot(page, BASE);
    const coldBytes = log.bytes;
    console.log(`  first visit: usable month view after ${coldMs} ms, ${(coldBytes / 1e6).toFixed(1)} MB transferred (no compression here)`);
    check(['', '#/'].includes(new URL(page.url()).hash), 'opens on the calendar with no sign-in (no #/login)', page.url());
    check((await page.locator('input[type=password]').count()) === 0, 'no sign-in form');
    check((await page.locator('.month').count()) === 1 && (await page.locator('.month .mline').count()) > 20, 'month view with the demo routes', await page.locator('.month .mline').count());
    check(/Demo with sample data/.test(await page.locator('.demo-bar').innerText()), 'the demo banner says it is a demo with sample data', await page.locator('.demo-bar').innerText());
    const nav = await page.locator('nav.tabs').innerText();
    check(/Calendar/.test(nav) && !/Users/.test(nav), 'navigation without Users', nav);
    check((await page.locator('header.top button[aria-haspopup="menu"]').count()) === 0, 'no user menu (no sign out, no change password)');
    const meta = await api(page, 'GET', '/meta');
    check(meta.me.role === 'admin' && meta.timezone === 'Asia/Singapore', 'signed in as the demo admin, in the visitor\'s time zone', [meta.me.role, meta.timezone]);
    const todayNum = page.locator(`.month .mcell[data-date="${meta.today}"] .dnum`);
    check((await todayNum.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(0, 105, 162)', `today (${meta.today}) has the blue circle`);
    if (meta.today === builtToday) {
      const tot = page.locator(`.month .mcell[data-date="${meta.today}"] [data-testid=month-totals]`);
      check((await tot.count()) === 1 && /REL [\d,.]+ kg/.test(await tot.innerText()), "today's seeded runs: the cell shows REL totals", (await tot.count()) && (await tot.innerText()));
      check(/\d+\/\d+/.test(await page.locator(`.month .mcell[data-date="${meta.today}"]`).innerText()), "today's lines show run progress (n/m)");
    } else {
      console.log(`  (the data was made on ${builtToday}, today is ${meta.today}: the run checks of today are skipped)`);
    }
    check(await noOverflow(page), 'no horizontal overflow at 1440 (month)');
    await shot(page, 'demo-01-month');
    await api(page, 'GET', `/calendar?view=month&anchor=${meta.today}`);
    await page.waitForTimeout(300);
    check((await saveState(page)) === 'saved' && (await storedCopy(page)) === null, 'opening the demo saves nothing (its sign-in is not a change): a later deploy reaches this visitor', [await saveState(page), await storedCopy(page)]);
    const routesBefore = JSON.stringify((await api(page, 'GET', '/routes?ended=1')).map((r) => [r.id, r.code, r.rev, r.start, r.end]));

    // >4 lines: collapse / expand, Expand all / Collapse all
    const cell = page.locator('.month .mcell:has(.mmore)').first();
    const lines = cell.locator('.mline');
    check((await lines.count()) === 4 && /^\d+ more ▾$/.test((await cell.locator('.mmore').innerText()).trim()), 'a day with more than 4 lines shows 4 and "N more ▾"');
    const n = 4 + Number((await cell.locator('.mmore').innerText()).match(/\d+/)[0]);
    await cell.locator('.mmore').click();
    check((await lines.count()) === n && /Show less/.test(await cell.locator('.mmore').innerText()), `"more" expands the cell in place (${n} lines)`);
    await cell.locator('.mmore').click();
    check((await lines.count()) === 4, '"Show less" collapses it');
    await page.getByRole('button', { name: /^Expand all/ }).click();
    check((await page.locator('.month .mmore[aria-expanded="false"]').count()) === 0, 'Expand all opens every cell');
    await page.getByRole('button', { name: /^Collapse all/ }).click();
    check((await page.locator('.month .mmore[aria-expanded="true"]').count()) === 0, 'Collapse all closes them');

    // Week view
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await page.locator('.week .occ').first().waitFor();
    check((await page.locator('.week .occ').count()) > 10, 'the week view shows the routes');
    check(await noOverflow(page), 'no horizontal overflow at 1440 (week)');
    await page.setViewportSize({ width: 1280, height: 900 });
    check(await noOverflow(page), 'no horizontal overflow at 1280 (week)');
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await page.locator('.month .mline').first().waitFor();
    check(await noOverflow(page), 'no horizontal overflow at 1280 (month)');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ---- A real edit round trip -------------------------------------------------------------
    console.log('  edit round trip');
    const workDayFrom = async (from) => {
      for (let d = from, i = 0; i < 40; i++, d = addDays(d, 1)) {
        const cal = await api(page, 'GET', `/calendar?view=week&anchor=${d}`);
        if (cal.days.find((x) => x.date === d)?.class === 'work') return d;
      }
      throw new Error('no work day after ' + from);
    };
    const D1 = await workDayFrom(addDays(meta.today, 7));
    let D2 = addDays(D1, 7);
    while ((await api(page, 'GET', `/calendar?view=week&anchor=${D2}`)).days.find((x) => x.date === D2).class !== 'work') D2 = addDays(D2, 7);
    const occ = async (date) => (await api(page, 'GET', `/calendar?view=week&anchor=${date}`)).routes.find((o) => o.date === date && o.code === 'Z9');
    const z9Records = async () => (await api(page, 'GET', '/routes?ended=1')).filter((r) => r.code === 'Z9').sort((a, b) => a.start.localeCompare(b.start));

    await page.goto(`${BASE}#/?view=week&anchor=${D1}`);
    const col = page.locator(`.week .day[data-date="${D1}"]`);
    await col.locator('.occ').first().waitFor();
    await col.getByRole('button', { name: '+ Route' }).click();
    await page.getByRole('menuitem', { name: 'Regular · repeats weekly' }).click();
    const rf = page.locator('.dialog', { hasText: 'New Regular route' });
    await rf.locator('input.code').fill('Z9');
    await rf.locator('label.field', { hasText: 'Name' }).locator('input').fill('Demo e2e route');
    await rf.getByRole('button', { name: 'Create', exact: true }).click();
    await rf.waitFor({ state: 'detached' });
    const nd = page.locator('.drawer', { hasText: 'Demo e2e route' });
    await nd.locator('.rd-title').waitFor({ timeout: 10000 });
    await nd.getByRole('button', { name: /Add customer/ }).click(); // the picker stays open after a pick
    for (const q of ['Golden', 'Kopi']) {
      await nd.locator('.picker input[type=search]').fill(q);
      await nd.locator('.picker-item').first().click();
    }
    await nd.getByRole('button', { name: 'Save', exact: true }).click();
    const sc1 = page.locator('.dialog', { hasText: 'Apply this change to' });
    await sc1.waitFor();
    await sc1.getByRole('button', { name: 'Save', exact: true }).click();
    await nd.waitFor({ state: 'detached' });
    const recs1 = await z9Records();
    const [A, B] = (await occ(D2))?.stops.map((s) => s.customer_id) ?? [];
    check(recs1.length === 1 && recs1[0].start === D1 && recs1[0].stop_count === 2 && !!B, `created route Z9 from ${D1} with two customers (also on ${D2})`, recs1.map((r) => [r.start, r.stop_count]));

    await page.goto(`${BASE}#/?view=week&anchor=${D2}`);
    await page.locator(`.week .day[data-date="${D2}"] .occ[data-code="Z9"] .nm`).click();
    const dr = page.locator('.drawer');
    await dr.locator('.stoplist .stop').first().waitFor();
    await dragTo(page, dr.locator(`.stop[data-cid="${B}"] .handle`), dr.locator(`.stop[data-cid="${A}"] .handle`));
    const dragged = await dr.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    check(dragged.join() === [B, A].join(), 'the second customer was dragged to #1', dragged);
    await dr.getByRole('button', { name: 'Save', exact: true }).click();
    const sc2 = page.locator('.dialog', { hasText: 'Apply this change to' });
    await sc2.locator('input[type=radio]').nth(1).check();
    await sc2.getByRole('button', { name: 'Save', exact: true }).click();
    await dr.waitFor({ state: 'detached' });
    const recs2 = await z9Records();
    const order = async (d) => (await occ(d))?.stops.map((s) => s.customer_id).join();
    check(recs2.length === 2 && recs2[1].start === D2, `"${D2} and all following" split Z9 at ${D2}`, recs2.map((r) => [r.start, r.end]));
    check((await order(D1)) === [A, B].join() && (await order(D2)) === [B, A].join() && (await order(addDays(D2, 7))) === [B, A].join(), 'the earlier date keeps A, B; from the split on it is B, A');

    await page.goto(`${BASE}#/?view=week&anchor=${D1}`);
    await page.locator(`.week .day[data-date="${D1}"] .occ[data-code="Z9"] .nm`).click();
    await dr.locator(`.stop[data-cid="${A}"]`).getByRole('button', { name: /^Remove from route/ }).click();
    await dr.getByRole('button', { name: 'Save', exact: true }).click();
    const sc3 = page.locator('.dialog', { hasText: 'Apply this change to' });
    await sc3.waitFor();
    await sc3.getByRole('button', { name: 'Save', exact: true }).click();
    await dr.waitFor({ state: 'detached' });
    check((await order(D1)) === String(B) && (await occ(D1)).edited, `a customer was removed on ${D1} only`);
    check(await saved(page), 'the data was saved in this browser (IndexedDB)');
    const copy = await storedCopy(page);
    check(!!copy && copy.version === JSON.parse(fs.readFileSync(path.join(DIST, 'assets', bundleFile), 'utf8')).version && !!copy.rev, 'the saved copy carries the deploy\'s version and a save mark', copy);

    // ---- Reload keeps the edits ------------------------------------------------------------------
    await page.goto(`${BASE}#/?anchor=${D2}`);
    const warmMs = await boot(page);
    console.log(`  reload: usable month view after ${warmMs} ms`);
    check((await z9Records()).length === 2 && (await order(D1)) === String(B) && (await order(D2)) === [B, A].join(), 'after a reload the edits are still there');
    check((await page.locator(`.month .mcell[data-date="${D2}"] .mline[data-code="Z9"]`).count()) === 1 || (await page.locator(`.month .mcell[data-date="${D2}"] .mmore`).count()) === 1, `Z9 shows on ${D2} in the month view`);

    // ---- zh / en ----------------------------------------------------------------------------------
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await poll(async () => /日历/.test(await page.locator('nav.tabs').innerText()));
    check(/日历/.test(await page.locator('nav.tabs').innerText()) && /演示版/.test(await page.locator('.demo-bar').innerText()), '中文: the app and the banner switch to Chinese');
    await shot(page, 'demo-02-zh');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await poll(async () => /Calendar/.test(await page.locator('nav.tabs').innerText()));
    check(/Calendar/.test(await page.locator('nav.tabs').innerText()) && /Demo with sample data/.test(await page.locator('.demo-bar').innerText()), 'EN: back to English');

    // ---- Delete the route (both parts) -----------------------------------------------------------
    await page.goto(`${BASE}#/?view=week&anchor=${D2}`);
    await page.locator(`.week .day[data-date="${D2}"] .occ[data-code="Z9"] .nm`).click();
    await dr.getByRole('button', { name: /Menu/ }).click();
    await page.getByRole('menuitem', { name: 'Delete route…' }).click();
    const del = page.locator('.dialog', { hasText: 'Delete route Z9' });
    const delText = await poll(async () => {
      const x = await del.locator('[data-testid=delete-text]').innerText();
      return /runs as 2 schedules/.test(x) ? x : null;
    });
    check(!!delText, 'the delete dialog names both schedules of Z9', delText);
    await del.getByRole('button', { name: 'Delete', exact: true }).click();
    await del.waitFor({ state: 'detached' });
    check((await z9Records()).length === 0, 'Z9 is deleted');
    check(await saved(page), 'saved again');

    // ---- Reset restores the original data -----------------------------------------------------
    await page.getByRole('button', { name: 'Reset demo data' }).click();
    const rd = page.locator('.dialog', { hasText: 'Remove all your changes' });
    await rd.waitFor();
    await Promise.all([page.waitForEvent('load'), rd.getByRole('button', { name: 'Reset demo data' }).click()]);
    await page.locator('.week .occ').first().waitFor({ timeout: 60000 }); // it reloads the page (still the week view)
    await page.goto(BASE + '#/');
    await page.locator('.month .mline').first().waitFor();
    const routesAfter = JSON.stringify((await api(page, 'GET', '/routes?ended=1')).map((r) => [r.id, r.code, r.rev, r.start, r.end]));
    check(routesAfter === routesBefore, 'Reset demo data: the routes are exactly the original ones again');

    // ---- A new backend version drops an older saved copy, with a notice ---------------------------
    await api(page, 'POST', '/customers', { code: 'ZZ01', name: 'Version test', address: '1 Test Rd', phone: '', note: '', waste_types: ['REL'] });
    check(await saved(page), 'a new customer is saved');
    await page.evaluate(async () => {
      // the saved copy as an older deploy would have left it (idb-keyval: database wms-demo, store kv, key data)
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('wms-demo');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const get = store.get('data');
      await new Promise((resolve) => (get.onsuccess = resolve));
      store.put({ ...get.result, version: 'an-older-backend' }, 'data');
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    });
    await boot(page);
    check(/The demo was updated/.test(await page.locator('.demo-bar').innerText()), 'after an update of the backend the banner says the changes were reset', await page.locator('.demo-bar').innerText());
    check((await api(page, 'GET', '/customers?q=Version%20test')).length === 0, 'and the demo starts again from the original data');

    // ---- Phone width ------------------------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const bar = await page.locator('.demo-bar').boundingBox();
    const reset = await page.getByRole('button', { name: 'Reset demo data' }).boundingBox();
    check(bar.width <= 390 && reset.x >= 0 && reset.x + reset.width <= 390, 'phone width: the banner and its reset button fit the screen', { bar, reset });
    // On failure: the page's scroll width and the elements that reach furthest right (tag.class, right edge,
    // width, text, month cell).
    const tooWide = () =>
      page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        widest: [...document.querySelectorAll('body *')]
          .map((e) => [e, e.getBoundingClientRect()])
          .filter(([, r]) => r.width > 0 && r.right > window.innerWidth - 1)
          .sort((a, b) => b[1].right - a[1].right)
          .slice(0, 10)
          .map(([e, r]) => `${e.tagName}.${String(e.className).slice(0, 30)} right=${r.right.toFixed(2)} w=${r.width.toFixed(2)} sw=${e.scrollWidth} "${(e.textContent || '').slice(0, 24)}" ${e.closest('.mcell')?.dataset.date || ''}`),
      }));
    check(await noOverflow(page), 'phone width: no horizontal page overflow', await tooWide());
    check((await page.locator('.month .mcell').count()) >= 28, 'phone width: the month grid is there');
    await shot(page, 'demo-03-phone');
    await ctx.close();

    // ---- B: an unknown prefix, a visitor west of Singapore ------------------------------------
    console.log(`B. ${BASE2} (America/Los_Angeles, 1280×900)`);
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'zh-CN' });
    watch(ctx2, log);
    const p2 = await ctx2.newPage();
    await boot(p2, BASE2);
    const meta2 = await api(p2, 'GET', '/meta');
    check(['America/Los_Angeles', 'Asia/Singapore'].includes(meta2.timezone), `the visitor's zone, or Singapore's while the visitor's date is before the data's (${meta2.timezone}, today ${meta2.today})`);
    check(/日历/.test(await p2.locator('nav.tabs').innerText()) && /演示版/.test(await p2.locator('.demo-bar').innerText()), 'a Chinese browser gets the demo in Chinese');
    check((await api(p2, 'GET', '/routes?ended=1')).every((r) => r.code !== 'Z9'), "a new visitor (another origin) gets the original data, not A's edits");
    await p2.locator('nav.tabs a', { hasText: '路线' }).click();
    await p2.locator('table tbody tr').first().waitFor();
    check(/#\/routes$/.test(p2.url()), 'the Routes page is a #/routes URL', p2.url());
    await p2.reload();
    await p2.locator('table tbody tr').first().waitFor({ timeout: 120000 });
    check((await p2.locator('table tbody tr').count()) > 10, 'reloading #/routes works on a host that knows no app routes');
    const direct = await fetch(`${BASE2}routes`);
    check(direct.status === 404, `the host itself answers 404 for ${RANDOM_PREFIX}routes (nothing relies on it)`, direct.status);
    await ctx2.close();

    // ---- C: storage blocked ----------------------------------------------------------------------
    console.log('C. storage blocked (IndexedDB throws)');
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    await ctx3.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    });
    watch(ctx3, log);
    const p3 = await ctx3.newPage();
    await boot(p3, BASE);
    check(/does not allow saving/.test(await p3.locator('.demo-bar').innerText()), 'the banner says changes are not kept', await p3.locator('.demo-bar').innerText());
    check((await p3.evaluate(() => document.documentElement.dataset.demoSave)) === 'off', 'saving is off');
    await p3.getByRole('button', { name: '中文', exact: true }).click(); // a write (PATCH /api/me)
    await poll(async () => /日历/.test(await p3.locator('nav.tabs').innerText()));
    check(/日历/.test(await p3.locator('nav.tabs').innerText()) && (await api(p3, 'GET', '/me')).lang === 'zh', 'the demo still works (reads and writes)');
    await ctx3.close();

    // ---- D: a browser without JSPI (Safari, Firefox today): php-wasm's Asyncify build -------------
    console.log('D. no JSPI (Asyncify build)');
    const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    await ctx4.addInitScript(() => {
      delete WebAssembly.Suspending;
      delete WebAssembly.promising;
    });
    watch(ctx4, log);
    const p4 = await ctx4.newPage();
    const wasmFiles = [];
    p4.on('request', (r) => r.url().endsWith('.wasm') && wasmFiles.push(r.url()));
    await boot(p4, BASE2);
    const jspiFile = log.requests.find((u) => u.startsWith(BASE) && u.endsWith('.wasm'));
    check(wasmFiles.length === 1 && !!jspiFile && wasmFiles[0].split('/').pop() !== jspiFile.split('/').pop(), 'without JSPI it loads the other (Asyncify) PHP build', [wasmFiles, jspiFile]);
    await api(p4, 'POST', '/customers', { code: 'AS01', name: 'Asyncify test', address: '1 Test Rd', phone: '', note: '', waste_types: ['REL'] });
    check((await api(p4, 'GET', '/customers?q=Asyncify')).length === 1, 'and the backend reads and writes as with JSPI');
    await ctx4.close();

    // ---- E: two tabs of the demo in one browser ---------------------------------------------------------
    console.log('E. two tabs');
    const ctx5 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    watch(ctx5, log);
    const t1 = await ctx5.newPage();
    const t2 = await ctx5.newPage();
    await boot(t1, BASE);
    await boot(t2, BASE);
    const cust = (code) => ({ code, name: 'Tab test ' + code, address: '1 Tab Rd', phone: '', note: '', waste_types: ['REL'] });
    const has = async (p, code) => (await api(p, 'GET', '/customers?q=' + code)).some((c) => c.code === code);
    // A tab that is not being typed in follows the other tab by itself: it loads the new data.
    await Promise.all([t2.waitForEvent('load', { timeout: 20000 }), api(t1, 'POST', '/customers', cust('TAB0'))]);
    await t2.locator('.month .mline').first().waitFor({ timeout: 60000 });
    check((await has(t2, 'TAB0')) && (await saveState(t2)) === 'saved', 'tab 2 loads the change of tab 1 by itself (no click), and saves again');
    // While the visitor types in tab 2 it does not reload: it is told, and keeps its hands off the saved copy.
    await t2.locator('input[type=search]').focus();
    await api(t1, 'POST', '/customers', cust('TABA'));
    check(await saved(t1), 'tab 1: a change is saved');
    check(await poll(async () => (await saveState(t2)) === 'otherTab'), 'tab 2 (typing) is told at once that the demo changed in another tab', await saveState(t2));
    check(/changed in another tab/.test(await t2.locator('.demo-bar').innerText()) && (await t2.getByRole('button', { name: 'Reload this page' }).count()) === 1, 'tab 2: the banner says so, with "Reload this page"', await t2.locator('.demo-bar').innerText());
    await api(t2, 'POST', '/customers', cust('TABB'));
    await t2.waitForTimeout(300);
    await boot(t1);
    check((await has(t1, 'TABA')) && !(await has(t1, 'TABB')), "tab 2's later change did not overwrite tab 1's saved one");
    await Promise.all([t2.waitForEvent('load'), t2.getByRole('button', { name: 'Reload this page' }).click()]);
    await t2.locator('.month .mline').first().waitFor({ timeout: 60000 });
    check((await has(t2, 'TABA')) && (await saveState(t2)) === 'saved', 'tab 2 after "Reload this page": the latest data, saving again');
    await t2.locator('input[type=search]').focus();
    await t1.getByRole('button', { name: 'Reset demo data' }).click();
    await Promise.all([t1.waitForEvent('load'), t1.locator('.dialog').getByRole('button', { name: 'Reset demo data' }).click()]);
    await t1.locator('.month .mline').first().waitFor({ timeout: 60000 });
    check(await poll(async () => (await saveState(t2)) === 'otherTab'), 'a Reset in tab 1 stops tab 2 from saving its older data back');
    await api(t2, 'POST', '/customers', cust('TABC'));
    await t2.waitForTimeout(300);
    await boot(t1);
    check(!(await has(t1, 'TABA')) && !(await has(t1, 'TABC')) && (await storedCopy(t1)) === null, 'after the Reset the original data stays');
    await ctx5.close();

    // ---- F: a browser that reports an older zone name ------------------------------------------------
    console.log('F. Pacific/Chuuk (Chromium reports the older name Pacific/Truk)');
    const ctx6 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Chuuk', locale: 'en-SG' });
    watch(ctx6, log);
    const p6 = await ctx6.newPage();
    await boot(p6, BASE);
    const zone = await p6.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    check((await api(p6, 'GET', '/meta')).timezone === zone, `the backend runs in the zone the browser reports (${zone}), not in Singapore's`);
    await ctx6.close();

    // ---- G: the demo's own code does not load (its console errors are expected: not watched) ---------
    console.log('G. the DemoApp chunk fails to load');
    const ctx7 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    await ctx7.route(/\/assets\/DemoApp-[^/]*\.js$/, (r) => r.abort('failed'));
    const p7 = await ctx7.newPage();
    await p7.goto(BASE);
    const alert = p7.getByRole('alert');
    await alert.waitFor({ timeout: 30000 });
    check(/The demo could not start/.test(await alert.innerText()) && /演示无法启动/.test(await alert.innerText()), 'an error screen in zh and en, not "Loading" forever', await alert.innerText());
    await ctx7.unroute(/\/assets\/DemoApp-[^/]*\.js$/);
    await Promise.all([p7.waitForEvent('load'), alert.getByRole('button', { name: /Try again/ }).click()]);
    await p7.locator('.month .mline').first().waitFor({ timeout: 120000 });
    check((await p7.locator('.demo-bar').count()) === 1, '"Try again" then opens the demo');
    await ctx7.close();

    // ---- H: the driver demo, the same host one folder down (./driver/) --------------------------------
    console.log('H. the driver app demo at ./driver/');
    const { devices } = require('playwright');
    const ctx8 = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'Asia/Singapore', locale: 'en-SG' });
    watch(ctx8, log);
    const p8 = await ctx8.newPage();
    await p8.goto(BASE + 'driver/');
    await p8.locator('[data-testid=routes-head]').waitFor({ timeout: 120000 });
    check(new URL(p8.url()).pathname === PAGES_PREFIX + 'driver/' && /#\/driver$/.test(p8.url()), 'the driver demo opens at ./driver/ with no sign-in', p8.url());
    const me = await api(p8, 'GET', '/me');
    check(me.role === 'driver' && me.username === 'bala', 'signed in as the demo driver (Bala)', me);
    check(/Driver app demo/.test(await p8.locator('.demo-bar').innerText()) && (await p8.locator('.month, .week').count()) === 0, 'it shows the driver app with its own demo banner, not the calendar');
    check((await p8.locator('button.jcard[data-code]').count()) >= 1 && (await p8.locator('button.jcard[data-code] .wtag').first().innerText()).length > 0, 'Today lists the routes with their waste-type tag');
    check(await noOverflow(p8), 'no horizontal overflow at phone width');
    await shot(p8, '30-driver-today');
    // A free submission, end to end, with the backend in this tab.
    const today8 = (await api(p8, 'GET', '/driver/today')).today;
    const before8 = (await api(p8, 'GET', `/driver/submissions?date=${today8}`)).submissions.length;
    await p8.click('[data-testid=submit-new]');
    await p8.waitForSelector('[data-testid=submit-page]');
    await p8.click('button[data-type="EROSE"]');
    await p8.locator('[data-testid=submit-customers] button[data-customer]').first().click();
    await p8.waitForSelector('[data-testid=result-form]');
    await p8.fill('input[name="weight-EROSE"]', '64.5');
    await p8.selectOption('select[name=plate]', 'SBA1234X');
    await p8.click('[data-testid=save-collected]');
    await p8.waitForURL(/#\/driver$/);
    const mine8 = await poll(async () => {
      const l = (await api(p8, 'GET', `/driver/submissions?date=${today8}`)).submissions;
      return l.length === before8 + 1 ? l : null;
    }, 20000);
    const new8 = mine8 && mine8.find((x) => x.waste_type === 'EROSE');
    check(new8 && new8.weights.EROSE === 64.5 && new8.vehicle_no === 'SBA1234X', 'a submission made in the driver demo is stored by the backend in the tab', new8 && new8.weights);
    check((await p8.locator(`[data-submission="${new8 && new8.id}"]`).count()) === 1, 'and Today lists it');
    check(await saved(p8), 'the change is saved in this browser');
    // The office demo (same browser, same saved data) shows it; each banner links to the other page.
    check((await p8.locator('[data-testid=demo-other]').getAttribute('href')) === '../', 'the driver banner links to the office demo');
    await Promise.all([p8.waitForEvent('load'), p8.click('[data-testid=demo-other]')]);
    await p8.locator('.month .mcell').first().waitFor({ timeout: 120000 });
    check(new URL(p8.url()).pathname === PAGES_PREFIX && (await api(p8, 'GET', '/me')).role === 'admin', 'that link opens the office calendar demo, as the demo admin');
    const office8 = (await api(p8, 'GET', `/submissions?date=${today8}`)).submissions;
    check(office8.some((x) => x.id === new8.id && x.driver === 'Bala'), "the office demo's Submissions list has the driver's submission (shared saved data)");
    check((await p8.locator('[data-testid=demo-other]').getAttribute('href')) === './driver/', 'the office banner links to the driver demo');
    // Reset restores the original data for both pages.
    // (a saved copy keeps the admin's own language, so the button is matched in both)
    const RESET = /Reset demo data|重置演示数据/;
    await p8.locator('.demo-bar').getByRole('button', { name: RESET }).click();
    await Promise.all([p8.waitForEvent('load'), p8.getByRole('dialog').getByRole('button', { name: RESET }).click()]);
    await p8.locator('.month .mcell').first().waitFor({ timeout: 120000 });
    check(!(await api(p8, 'GET', `/submissions?date=${today8}`)).submissions.some((x) => x.id === new8.id), 'Reset demo data removes it again');
    // The other sub-path works too.
    await p8.goto(BASE2 + 'driver/');
    await p8.locator('[data-testid=routes-head]').waitFor({ timeout: 120000 });
    check((await api(p8, 'GET', '/me')).role === 'driver', 'the driver demo runs from any sub-path');
    await ctx8.close();

    // ---- Over all pages -----------------------------------------------------------------------
    const apiCalls = log.requests.filter((u) => /\/api(\/|$|\?)/.test(new URL(u).pathname));
    check(apiCalls.length === 0, `no request went to an /api URL (${log.requests.length} requests in total)`, apiCalls.slice(0, 5));
    const foreign = log.requests.filter((u) => !u.startsWith(BASE) && !u.startsWith(BASE2) && !u.startsWith('data:') && !u.startsWith('blob:'));
    check(foreign.length === 0, 'every request stayed on the static host', foreign.slice(0, 5));
    check(log.errors.length === 0, 'no console errors', log.errors.slice(0, 5));
  } finally {
    await browser.close();
    for (const s of servers) s.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
