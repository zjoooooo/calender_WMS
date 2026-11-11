// End-to-end test of the office calendar (M3–M7 office side, Round 5 month view) at 1440×1000.
// Starts its own backend (php -S) and Vite, seeds demo data through the API (scripts/seed-demo.mjs,
// with live runs), drives Chromium with Playwright and checks every result through the API, then stops both.
//
//   cd frontend && node e2e/office.e2e.cjs        (or: npm run e2e:office)
//
// Env (defaults): BACKEND_PORT=8281  FRONT_PORT=5281  WMS_DATA_DIR=/tmp/wms-test-office
//                 E2E_SHOTS=<dir> to save screenshots   KEEP_DATA=1 to keep the data dir
// Dates are taken from the server (today, next work day, the next Mon–Sat PH, the next Sunday), so the
// test works on any day. The data dir is WIPED at the start (and at the end unless KEEP_DATA=1).
/* eslint-disable no-console */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONT = path.join(ROOT, 'frontend');
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8281);
const FRONT_PORT = Number(process.env.FRONT_PORT || 5281);
const DATA = process.env.WMS_DATA_DIR || '/tmp/wms-test-office';
const SHOTS = process.env.E2E_SHOTS || '';
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}`;
const ADMIN_PW = 'demo-pass-2026';

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
let token = null;
async function api(method, p, body) {
  const r = await fetch(API + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = r.status === 204 ? { ok: true, data: null } : await r.json();
  if (!j.ok) throw new Error(`${method} ${p}: ${j.error?.code}`);
  return j.data;
}
const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
async function occOn(date, code) {
  const cal = await api('GET', `/calendar?view=week&anchor=${date}`);
  return { cal, occ: cal.routes.filter((o) => o.date === date && o.code === code) };
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}
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

const BLUE = 'rgb(37, 99, 235)'; // --cal-today (light theme)
const RED = 'rgb(220, 38, 38)'; // --cal-ph (light theme)
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Month view checks (§9.2, Round 5). Leaves tomorrow's first regular route edited (only that date) and an
 *  extra OTC task on tomorrow, plus one adhoc route on workDay. */
async function monthChecks(page, { today, tomorrow, workDay, ph }) {
  console.log('month view (default)');
  check(!new URL(page.url()).searchParams.get('view') && (await page.locator('.month').count()) === 1 && (await page.locator('.week').count()) === 0, 'the calendar opens in the month view');
  const heads = await page.locator('.month .mh').allInnerTexts();
  check(heads.join(' ') === 'Sun Mon Tue Wed Thu Fri Sat', 'weekday header Sun..Sat', heads);
  const cells = await page.locator('.month .mcell').evaluateAll((els) => els.map((e) => e.dataset.date));
  check(new Date(cells[0] + 'T00:00:00Z').getUTCDay() === 0, 'the first column is a Sunday', cells[0]);
  const mcal = await api('GET', `/calendar?view=month&anchor=${today}&week_start=sun`);
  let rows = 0;
  for (let i = 0; i < 42; i += 7) if (mcal.days.slice(i, i + 7).some((d) => d.in_month)) rows++;
  check(cells.length === rows * 7 && rows >= 4 && rows <= 6, `only the week rows of the month are drawn (${rows} rows)`, cells.length);
  check((await page.locator('.cal-title').innerText()).includes(String(today.slice(0, 4))), 'big month title with the year', await page.locator('.cal-title').innerText());
  const tnum = page.locator(`.month .mcell[data-date="${today}"] .dnum`);
  const tStyle = await tnum.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
  check(tStyle[0] === BLUE && tStyle[1] === 'rgb(255, 255, 255)', "today's number: white on a blue circle", tStyle);
  check(await noOverflow(page), 'no horizontal overflow at 1440');
  // Daily totals per waste type are visible in the month view too (DRV-3).
  const tTot = page.locator(`.month .mcell[data-date="${today}"] [data-testid=month-totals]`);
  check((await tTot.count()) === 1 && /REL [\d,.]+ kg/.test(await tTot.innerText()), "today's cell shows the day's totals (REL … kg)", (await tTot.count()) && (await tTot.innerText()));
  await shot(page, '00-month');

  // A day with more than 4 lines: 4 + "N more"; expand / collapse in place; a refetch keeps it open.
  await page.goto(`${BASE}/?anchor=${tomorrow}`);
  const cell = page.locator(`.month .mcell[data-date="${tomorrow}"]`);
  await cell.locator('.mline').first().waitFor();
  const lines = cell.locator('.mline');
  const occ = async () => {
    const c = await api('GET', `/calendar?view=week&anchor=${tomorrow}&week_start=sun`);
    return [...c.routes.filter((o) => o.date === tomorrow && o.status !== 'holiday_skipped'), ...c.tasks.filter((o) => o.date === tomorrow)];
  };
  const items = await occ();
  const n = items.length;
  check(n > 4 && (await lines.count()) === 4, `${tomorrow} has ${n} lines: exactly 4 are shown`, await lines.count());
  const more = cell.locator('.mmore');
  check((await more.innerText()).trim() === `${n - 4} more ▾`, `then "${n - 4} more ▾"`, await more.innerText());
  check((await more.getAttribute('title')).includes(items[4].code || ''), 'its tooltip lists the hidden lines');
  // search for a hidden route opens the cell by itself
  const hiddenRoute = items.slice(4).find((o) => o.kind === 'route' && !items.slice(0, 4).some((x) => x.code && x.code.includes(o.code)));
  if (hiddenRoute) {
    await page.fill('input[type=search]', hiddenRoute.code);
    await page.waitForTimeout(200);
    check((await cell.locator(`.mline[data-code="${hiddenRoute.code}"]:not(.dim)`).count()) === 1 && (await cell.locator('.mmore').count()) === 0, `searching ${hiddenRoute.code} opens the cell and keeps it lit`);
    await page.getByRole('button', { name: 'Clear highlight' }).click();
    check((await lines.count()) === 4, 'cleared: the cell collapses again');
  }
  await more.click();
  check((await lines.count()) === n && /Show less ▴/.test(await cell.locator('.mmore').innerText()), `"${n - 4} more" expands the cell in place (${n} lines, Show less)`);
  await shot(page, '00-month-expanded');
  // a refetch (new data from the server) must not collapse it
  const otcCust = (await api('GET', '/customers')).find((c) => c.waste_types.includes('OTC') && c.active !== false);
  await api('POST', '/tasks', { waste_type: 'OTC', customer_id: otcCust.id, date: tomorrow, note: 'e2e month refetch' });
  const resp = page.waitForResponse((r) => r.url().includes('/api/calendar') && r.status() === 200, { timeout: 40000 });
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await resp;
  await page.waitForTimeout(400);
  check((await lines.count()) === n + 1 && (await cell.locator('.mmore', { hasText: 'Show less' }).count()) === 1, 'after a refetch the cell stays expanded and shows the new task', await lines.count());
  await cell.locator('.mmore').click();
  check((await lines.count()) === 4 && /more ▾/.test(await cell.locator('.mmore').innerText()), '"Show less" collapses it again');
  // Expand all / Collapse all
  await page.getByRole('button', { name: /^Expand all/ }).click();
  check((await page.locator('.month .mmore[aria-expanded="false"]').count()) === 0 && (await lines.count()) === n + 1, 'Expand all opens every cell');
  await page.getByRole('button', { name: /^Collapse all/ }).click();
  check((await page.locator('.month .mmore[aria-expanded="true"]').count()) === 0 && (await lines.count()) === 4, 'Collapse all closes them');

  // Clicking a route line opens its drawer; the stop list is editable (↓, save only this date).
  const line = cell.locator('.mline:not(.adhoc):not(.task)').first();
  const code = await line.getAttribute('data-code');
  const key = await line.getAttribute('data-key');
  await line.click();
  const drawer = page.locator('.drawer');
  await drawer.locator('.stoplist .stop').first().waitFor();
  check(new RegExp(code).test(await drawer.locator('.rd-title').innerText()), `clicking the ${code} line opens its route drawer`);
  const before = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
  await drawer.locator(`.stop[data-cid="${before[0]}"]`).getByRole('button', { name: /^Move down/ }).click();
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  const scope = page.locator('.dialog', { hasText: 'Apply this change to' });
  await scope.waitFor();
  await scope.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer.waitFor({ state: 'detached' });
  const saved = (await occ()).find((o) => o.key === key);
  check(saved && saved.edited && saved.stops[0].customer_id === before[1] && saved.stops[1].customer_id === before[0], `the ${code} stop order was changed from the month view (only ${tomorrow})`);

  // "+" in a future cell: the create menu of that day; ⚡ Adhoc creates a route and opens its drawer.
  await page.goto(`${BASE}/?anchor=${workDay}`);
  const wcell = page.locator(`.month .mcell[data-date="${workDay}"]`);
  await wcell.locator('.mline').first().waitFor();
  const adhocBefore = (await api('GET', `/calendar?view=week&anchor=${workDay}`)).routes.filter((o) => o.date === workDay && o.type === 'adhoc').length;
  await wcell.hover();
  await wcell.locator('button.madd').click();
  const menu = await page.locator('.menu').innerText();
  check(/Regular · repeats weekly/.test(menu) && /Adhoc · this date only/.test(menu) && /\+ Task/.test(menu) && !/Special/.test(menu), '"+" offers the day\'s route kinds and + Task', menu);
  await page.getByRole('menuitem', { name: '⚡ Adhoc · this date only' }).click();
  const rf = page.locator('.dialog');
  await rf.getByRole('button', { name: 'Create', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  const nd = page.locator('.drawer');
  await nd.locator('.rd-title').waitFor({ timeout: 10000 });
  await nd.getByRole('button', { name: /Add customer/ }).click();
  await nd.locator('.picker input[type=search]').fill('Golden');
  await nd.locator('.picker-item').first().click();
  await nd.getByRole('button', { name: 'Save', exact: true }).click();
  const sc2 = page.locator('.dialog', { hasText: 'Apply this change to' });
  if (await sc2.isVisible().catch(() => false)) await sc2.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(800);
  const adhocs = (await api('GET', `/calendar?view=week&anchor=${workDay}`)).routes.filter((o) => o.date === workDay && o.type === 'adhoc');
  check(adhocs.length === adhocBefore + 1 && adhocs.some((o) => o.stops.length === 1), `"+" created an adhoc route on ${workDay} and its customer was added in the drawer`, adhocs.map((o) => [o.code, o.stops.length]));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await wcell.locator('.mline.adhoc').count()) === adhocBefore + 1, 'the new adhoc line shows in the cell (dashed)');

  // A Mon–Sat public holiday: red number, the ★ bar and the "⏸ N paused" line that opens the day drawer.
  if (ph) {
    await page.goto(`${BASE}/?anchor=${ph}`);
    const pcell = page.locator(`.month .mcell[data-date="${ph}"]`);
    await pcell.waitFor();
    check((await pcell.locator('.dnum').evaluate((e) => getComputedStyle(e).color)) === RED, `${ph}: the PH number is red`);
    check(/★/.test(await pcell.locator('.mph').innerText()), 'the holiday bar with ★ and the name', await pcell.locator('.mph').innerText());
    await pcell.locator('button.mpaused').click();
    await page.locator('.drawer .daydrawer button.paused').waitFor();
    check(true, '"⏸ N paused" opens the day drawer (Run on PH / Move to work day)');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  check(await noOverflow(page), 'no horizontal overflow at 1280');
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  // Asynchronous on purpose: a synchronous child would block this process, the php -S request log pipe
  // would fill up and the server would stall.
  const seedOut = await new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(FRONT, 'scripts/seed-demo.mjs'), '--api', API, '--data-dir', DATA, '--new-password', ADMIN_PW, '--with-runs']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('seed failed:\n' + out))));
  });
  console.log(seedOut.trim().split('\n').map((l) => '    ' + l).join('\n'));
  token = (await api('POST', '/login', { username: 'admin', password: ADMIN_PW })).token;
  const meta = await api('GET', '/meta');
  const today = meta.today;
  const tomorrow = meta.next_work_day;
  // A future Mon–Sat date where N1 and N2 run (not a PH), after the next work day.
  let workDay = addDays(tomorrow, 1);
  for (let i = 0; i < 14; i++, workDay = addDays(workDay, 1)) {
    const { occ } = await occOn(workDay, 'N2');
    if (occ.length && occ[0].status === 'scheduled') break;
  }
  const holidays = (await api('GET', '/holidays')).filter((h) => h.date > today);
  let ph = null;
  for (const h of holidays) {
    const { occ } = await occOn(h.date, 'N1');
    if (occ.length && occ[0].status === 'holiday_skipped') {
      ph = h.date;
      break;
    }
  }
  let sunday = addDays(today, 1);
  while (new Date(sunday + 'T00:00:00Z').getUTCDay() !== 0) sunday = addDays(sunday, 1);
  console.log(`dates: today ${today}, tomorrow ${tomorrow}, work day ${workDay}, PH ${ph}, Sunday ${sunday}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('dialog', (d) => d.accept());

  try {
    console.log('login (English UI)');
    await page.goto(BASE + '/login');
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', ADMIN_PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('.month .mline');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Week', exact: true }).waitFor();

    // 0. Month view (Round 5): the default, Sunday first, 4 lines + "N more", today blue, PH red, "+".
    await monthChecks(page, { today, tomorrow, workDay, ph });

    // 1. Week view (Sunday first) renders 12+ routes per work day, with live statuses.
    console.log('week view');
    await page.goto(BASE + '/?view=week');
    await page.locator('.week .occ').first().waitFor();
    const weekDates = await page.locator('.week .day').evaluateAll((els) => els.map((e) => e.dataset.date));
    check(weekDates.length === 7 && new Date(weekDates[0] + 'T00:00:00Z').getUTCDay() === 0, 'week view: 7 columns, Sunday first', weekDates);
    const todayDt = page.locator(`.week .day[data-date="${today}"] .dh .dt`);
    check((await todayDt.evaluate((e) => getComputedStyle(e).backgroundColor)) === BLUE, "week view: today's date on blue");
    const todayCol = page.locator(`.week .day[data-date="${today}"]`);
    const nextCol = page.locator(`.week .day[data-date="${tomorrow}"]`);
    const nToday = await todayCol.locator('.occ').count();
    const nNext = (await nextCol.count()) ? await nextCol.locator('.occ').count() : 0;
    check(Math.max(nToday, nNext) >= 12, `a day column renders 12+ one-line route rows (today ${nToday}, next work day ${nNext})`);
    check(await page.locator('.week .day.today').count() === 1, 'today has the accent ring');
    // OFF-8: in a 1440 px week every row keeps a readable part of its name (the status word moves to the tooltip).
    const nmW = await page.locator('.week .day .occ .nm').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    check(nmW.length > 0 && Math.min(...nmW) >= 30, `week rows: every name keeps >= 30 px (min ${Math.min(...nmW)} px)`, nmW.slice(0, 12));
    check((await page.locator('.legend .lchip').count()) >= 12, 'legend lists the route codes in range');
    if (nToday > 0) {
      const n1 = todayCol.locator('.occ[data-code="N1"]');
      check(/Ali/.test(await n1.innerText()), 'today N1 shows the driver status (✓ Ali …)', await n1.innerText());
      check((await todayCol.locator('.dh .opsline').count()) === 1, "today's header shows the ops line");
    }
    const adhocRow = page.locator('.week .occ.adhoc').first();
    check((await adhocRow.count()) === 1 && /⚡A/.test(await adhocRow.innerText()), 'adhoc row has the ⚡A tag and the dashed class');
    await shot(page, '01-week');

    // 2. Highlight from the legend dims everything else; clicking again clears it. Search by customer.
    console.log('highlight and search');
    await page.locator('.legend .lchip[data-code="E1"]').click();
    const e1Rows = page.locator('.week .occ[data-code="E1"]');
    const dimE1 = await e1Rows.evaluateAll((els) => els.filter((e) => e.classList.contains('dim')).length);
    const others = page.locator('.week .occ:not([data-code="E1"])');
    const dimOthers = await others.evaluateAll((els) => els.every((e) => e.classList.contains('dim')));
    check((await e1Rows.count()) > 0 && dimE1 === 0 && dimOthers, 'highlight E1: E1 rows stay, every other row dims');
    check(await page.locator('.legend .lchip.on[data-code="E1"]').count() === 1, 'the legend chip shows it is on');
    await shot(page, '02-highlight');
    await page.locator('.legend .lchip[data-code="E1"]').click();
    check((await page.locator('.week .occ.dim').count()) === 0, 'clicking the code again clears the highlight');
    await page.locator('.week .occ[data-code="W2"] button.code').first().click();
    check((await page.locator('.week .occ.dim').count()) > 0 && (await page.locator('.week .occ[data-code="W2"].dim').count()) === 0, 'clicking a code in a row highlights it');
    await page.keyboard.press('Escape');
    check((await page.locator('.week .occ.dim').count()) === 0, 'Esc clears the highlight');
    // Search for one customer (by name): exactly the routes that have it stay lit.
    const wk = await api('GET', `/calendar?view=week&anchor=${today}`);
    const e2occ = wk.routes.find((o) => o.code === 'E2');
    const cust = wk.customers[e2occ.stops[e2occ.stops.length - 1].customer_id];
    const expect = [...new Set(wk.routes.filter((o) => o.stops.some((x) => wk.customers[x.customer_id].name.toLowerCase().includes(cust.name.toLowerCase()))).map((o) => o.code))].sort();
    await page.fill('input[type=search]', cust.name);
    await page.waitForTimeout(200);
    const lit = (await page.locator('.week .occ:not(.dim)').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.code))])).sort();
    check(lit.includes('E2') && lit.join() === expect.join(), `search "${cust.name}" keeps only the routes with that customer`, { lit, expect });
    await page.getByRole('button', { name: 'Clear highlight' }).click();
    check((await page.locator('.week .occ.dim').count()) === 0, '[Clear highlight] clears the search');
    // type filter chip
    await page.locator('.tchip', { hasText: 'Adhoc' }).click();
    check((await page.locator('.week .occ.adhoc').count()) === 0, 'the ⚡A chip hides adhoc rows');
    await page.locator('.tchip', { hasText: 'Adhoc' }).click();

    // 3. A regular route on a Mon–Sat PH shows paused; Run on PH and Move to work day.
    console.log('PH paused');
    if (!ph) {
      check(false, 'found a future Mon–Sat public holiday with N1 paused');
    } else {
      await page.goto(`${BASE}/?view=week&anchor=${ph}`);
      const phCol = page.locator(`.week .day[data-date="${ph}"]`);
      await phCol.waitFor();
      const pausedBtn = phCol.locator('button.paused');
      check(/regular routes paused \(PH\)/.test(await pausedBtn.innerText()), `${ph}: "⏸ N regular routes paused (PH)" line`, await pausedBtn.innerText());
      check((await phCol.locator('.phtag').count()) === 1, 'the PH tag with its name');
      check((await phCol.locator('.occs .occ[data-code="N1"]').count()) === 0, 'N1 is not among the running routes');
      await pausedBtn.click();
      check((await phCol.locator('.pausedlist .occ[data-code="N1"]').count()) === 1, 'expanded: N1 is listed as paused');
      await shot(page, '03-ph');
      // Run on PH -> a special one-off N1-<DD> on the same date
      await phCol.locator('.pausedlist > div', { has: page.locator('.occ[data-code="N1"]') }).getByRole('button', { name: 'Run on PH' }).click();
      const dlg = page.locator('.dialog');
      await dlg.locator('text=Special (only this date)').waitFor();
      const code = await dlg.locator('input.code').inputValue();
      check(code === 'N1-' + ph.slice(8), `suggested copy code ${code}`);
      await dlg.getByRole('button', { name: 'Copy', exact: true }).click();
      await dlg.waitFor({ state: 'detached' });
      const after = await occOn(ph, code);
      check(after.occ.length === 1 && after.occ[0].type === 'special', `Run on PH created special ${code}`, after.occ.map((o) => o.type));
      const n1 = after.cal.routes.find((o) => o.date === ph && o.code === 'N1');
      check(n1 && n1.covered_by.some((c) => c.code === code), 'the paused N1 shows "covered by"');
      // Move a paused route to a work day keeps type regular
      await page.waitForTimeout(300);
      if (!(await phCol.locator('.pausedlist').count())) await phCol.locator('button.paused').click();
      const second = await phCol.locator('.pausedlist .occ').evaluateAll((els) => els.map((e) => e.dataset.code).find((c) => c !== 'N1'));
      await phCol.locator('.pausedlist > div', { has: page.locator(`.occ[data-code="${second}"]`) }).getByRole('button', { name: 'Move to work day…' }).click();
      let target = addDays(ph, 3);
      const dlg2 = page.locator('.dialog');
      // OFF-1: the default target is the first work day after the paused date, not tomorrow.
      const holSet = new Set((await api('GET', '/holidays')).map((h) => h.date));
      let expectMove = addDays(ph, 1);
      while (new Date(expectMove + 'T00:00:00Z').getUTCDay() === 0 || holSet.has(expectMove)) expectMove = addDays(expectMove, 1);
      await page.waitForTimeout(300);
      const defTarget = await dlg2.locator('input[type=date]').inputValue();
      check(defTarget === expectMove && defTarget !== tomorrow, `Move to work day: the target defaults to ${expectMove} (after the PH), not ${tomorrow}`, defTarget);
      const runsThen = (await occOn(expectMove, second)).occ.some((o) => o.status === 'scheduled');
      await page.waitForTimeout(200);
      check((await dlg2.locator('[data-testid=copy-already-runs]').count()) === (runsThen ? 1 : 0), `the dialog warns exactly when ${second} already runs on ${expectMove} (${runsThen})`);
      await dlg2.locator('input[type=date]').fill(target);
      await dlg2.locator('text=Regular (only this date)').waitFor();
      await dlg2.getByRole('button', { name: 'Copy', exact: true }).click();
      await dlg2.waitFor({ state: 'detached' });
      const moved = (await api('GET', `/calendar?view=week&anchor=${target}`)).routes.filter((o) => o.date === target && !o.recurring);
      check(moved.some((o) => o.type === 'regular' && o.copied_from), `Move to work day: a regular one-off (R tag) on ${target}`, moved.map((o) => [o.code, o.type]));
      // OFF-5: the group counts only what still needs a decision; a covered row shows its "→" once.
      await page.waitForTimeout(500);
      if (!(await phCol.locator('.pausedlist').count())) await phCol.locator('button.paused').click();
      const nPaused = (await occOn(ph, 'N1')).cal.routes.filter((o) => o.date === ph && o.status === 'holiday_skipped').length;
      const grp = await phCol.locator('button.paused').innerText();
      check(grp.includes(`${nPaused - 2} regular routes paused (PH) · 2 covered`), `paused group: "${nPaused - 2} … · 2 covered"`, grp);
      const n1Row = await phCol.locator('.pausedlist > div', { has: page.locator('.occ[data-code="N1"]') }).innerText();
      check((n1Row.match(/→/g) || []).length === 1, 'the covered N1 row shows "→ code date" once', n1Row);
      // OFF-7: deleting this PH is refused (the special N1 copy needs it); the conflict dialog closes with Esc.
      const phName = (await api('GET', '/holidays')).find((h) => h.date === ph).name;
      await page.goto(BASE + '/holidays');
      await page.getByRole('tab', { name: new RegExp(ph.slice(0, 4)) }).click();
      await page.locator('tr', { hasText: phName }).first().getByRole('button', { name: 'Delete' }).click();
      await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
      const conf = page.locator('.dialog', { hasText: 'One-off routes on this date' });
      await conf.waitFor();
      check((await page.locator('.dialog').count()) === 1, 'the holiday conflict replaces the delete confirmation (one dialog)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check((await page.locator('.dialog').count()) === 0 && (await page.locator('.scrim').count()) === 0, 'Esc closes the conflict dialog, no scrim left');
      check((await api('GET', '/holidays')).some((h) => h.date === ph), 'the holiday is still there');
    }

    // 4. Route drawer: add a customer, drag it to the top, save "only this date".
    console.log('drawer edit + drag + scope');
    await page.goto(`${BASE}/?view=week&anchor=${workDay}`);
    const col = page.locator(`.week .day[data-date="${workDay}"]`);
    await col.locator('.occ[data-code="N2"] .nm').click();
    const drawer = page.locator('.drawer');
    await drawer.waitFor();
    const before = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    await drawer.getByRole('button', { name: /Add customer/ }).click();
    await drawer.locator('.picker input[type=search]').fill('Jade');
    const firstHit = drawer.locator('.picker-item').first();
    await firstHit.waitFor();
    const pickedName = (await firstHit.locator('strong').innerText()).trim();
    await firstHit.click();
    const mid = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    const added = mid.find((id) => !before.includes(id));
    check(mid.length === before.length + 1 && mid[mid.length - 1] === added, `"${pickedName}" added at the end of the draft`);
    check((await drawer.locator('.stoplist.dirty').count()) === 1, 'the draft has the amber outline');
    await dragTo(page, drawer.locator(`.stop[data-cid="${added}"] .handle`), drawer.locator(`.stop[data-cid="${before[0]}"] .handle`));
    const dragged = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    check(dragged[0] === added && dragged.length === mid.length, 'mouse drag by the ⠿ handle moved it to #1', dragged.slice(0, 3));
    // ↑ ↓ and move to # on the same draft
    await drawer.locator(`.stop[data-cid="${before[0]}"]`).getByRole('button', { name: /^Move down/ }).click();
    const stepped = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    check(stepped[2] === before[0], '↓ moves a stop one step');
    await drawer.locator(`.stop[data-cid="${before[0]}"] button.seq`).click();
    await drawer.locator(`.stop[data-cid="${before[0]}"] input.seqin`).fill('2');
    await drawer.locator(`.stop[data-cid="${before[0]}"] input.seqin`).press('Enter');
    const typed = await drawer.locator('.stoplist .stop').evaluateAll((els) => els.map((e) => Number(e.dataset.cid)));
    check(typed[1] === before[0], '"move to #2" by typing in the seq field');
    await shot(page, '04-draft');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    const scope = page.locator('.dialog', { hasText: 'Apply this change to' });
    await scope.waitFor();
    check(await scope.locator('input[type=radio]').first().isChecked(), 'scope dialog defaults to "Only <date>"');
    await shot(page, '05-scope');
    await scope.getByRole('button', { name: 'Save', exact: true }).click();
    await drawer.waitFor({ state: 'detached' });
    const saved = (await occOn(workDay, 'N2')).occ[0];
    check(saved && saved.edited && saved.stops.map((s) => s.customer_id).join() === typed.join(), 'saved as an override of that date only, in the draft order', saved && saved.stops.map((s) => s.customer_id));
    let nextRun = addDays(workDay, 1);
    for (let i = 0; i < 7; i++, nextRun = addDays(nextRun, 1)) {
      const o = (await occOn(nextRun, 'N2')).occ[0];
      if (o && o.status === 'scheduled') {
        check(!o.stops.some((s) => s.customer_id === added) && !o.edited, `the next N2 run (${nextRun}) is unchanged`);
        break;
      }
    }
    check((await page.locator(`.week .day[data-date="${workDay}"] .occ[data-code="N2"] .ed`).count()) === 1, 'the row shows the edited mark');

    // 4b. R20 lost update (REV-1): another clerk saves while this drawer has an unsaved draft.
    console.log('drawer: someone else saved meanwhile');
    await col.locator('.occ[data-code="N2"] .nm').click();
    const dr = page.locator('.drawer');
    await dr.locator('.stoplist .stop').first().waitFor();
    const n2now = (await occOn(workDay, 'N2')).occ[0];
    const firstCid = n2now.stops[0].customer_id;
    await dr.locator(`.stop[data-cid="${firstCid}"]`).getByRole('button', { name: /^Remove from route/ }).click();
    const custAll = await api('GET', '/customers');
    const mei = custAll.find((c) => c.waste_types.includes('REL') && c.active !== false && !n2now.stops.some((x) => x.customer_id === c.id));
    await api('PUT', `/routes/${n2now.route_id}/dates/${workDay}`, { rev: n2now.rev, scope: 'this', stops: [...n2now.stops.map((x) => ({ customer_id: x.customer_id, note: x.note })), { customer_id: mei.id, note: '' }] });
    const refetched = page.waitForResponse((r) => r.url().includes('/api/calendar') && r.status() === 200, { timeout: 40000 });
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await refetched;
    await page.waitForTimeout(400);
    const meanwhile = dr.locator('[data-testid=changed-meanwhile]');
    check((await meanwhile.count()) === 1 && (await meanwhile.innerText()).includes(mei.name), 'the drawer says someone else saved meanwhile and names the added customer', (await meanwhile.count()) && (await meanwhile.innerText()));
    await dr.getByRole('button', { name: 'Save', exact: true }).click();
    const sc4 = page.locator('.dialog', { hasText: 'Apply this change to' });
    await sc4.waitFor();
    await sc4.getByRole('button', { name: 'Save', exact: true }).click();
    await dr.locator('.form-error').waitFor();
    check(/Someone else changed this/.test(await dr.locator('.form-error').innerText()), 'the save is refused (STALE_REVISION), the draft stays');
    const n2after = (await occOn(workDay, 'N2')).occ[0];
    check(n2after.stops.some((x) => x.customer_id === mei.id) && n2after.stops.some((x) => x.customer_id === firstCid), "the other clerk's customer is not silently removed", n2after.stops.map((x) => x.customer_id));
    await dr.getByRole('button', { name: 'Discard changes' }).click();
    check((await dr.locator(`.stop[data-cid="${mei.id}"]`).count()) === 1, 'Discard loads their version');
    await page.keyboard.press('Escape');
    await dr.waitFor({ state: 'detached' });

    // 5. Urgent pickup: adhoc for tomorrow with two customers.
    console.log('urgent pickup');
    await page.goto(BASE + '/?view=week');
    await page.locator('.week .occ').first().waitFor();
    await page.getByRole('button', { name: /Urgent pickup/ }).first().click();
    const urgent = page.locator('.dialog', { hasText: 'Urgent pickup' });
    await urgent.waitFor();
    check(await urgent.getByRole('button', { name: 'Next work day' }).getAttribute('aria-pressed') === 'true', 'date defaults to the next work day');
    const ids = [];
    for (const q of ['Golden Bakery', 'Lucky Seafood']) {
      await urgent.locator('.picker input[type=search]').fill(q);
      const hit = urgent.locator('.picker-item').first();
      await hit.waitFor();
      await hit.click();
      ids.push(q);
    }
    check((await urgent.locator('.picked .chip').count()) === 2, 'two customers picked');
    await urgent.locator('text=New ⚡ Adhoc, only this date').waitFor();
    const ucode = await urgent.locator('input.code').inputValue();
    await shot(page, '06-urgent');
    await urgent.getByRole('button', { name: 'Create route' }).click();
    await urgent.waitFor({ state: 'detached' });
    const adhoc = (await occOn(tomorrow, ucode)).occ[0];
    check(adhoc && adhoc.type === 'adhoc' && adhoc.stops.length === 2, `urgent pickup created adhoc ${ucode} on ${tomorrow} with 2 stops`, adhoc && [adhoc.type, adhoc.stops.length]);
    check((await page.locator(`.week .day[data-date="${tomorrow}"] .occ.adhoc[data-code="${ucode}"]`).count()) === 1, 'it shows in the week view (dashed ⚡A)');

    // 6. OTC task on a Sunday.
    console.log('OTC task on Sunday');
    await page.goto(`${BASE}/?view=week&anchor=${sunday}`);
    const sun = page.locator(`.week .day[data-date="${sunday}"]`);
    await sun.waitFor();
    check(!(await sun.locator('.day-foot').innerText()).includes('Regular'), 'Sunday offers no Regular');
    await sun.getByRole('button', { name: '+ Route' }).click();
    const menu = await page.locator('.menu').innerText();
    check(/Special · every Sunday/.test(menu) && /Special · this date only/.test(menu) && !/Adhoc/.test(menu), 'Sunday "+ Route" offers only Special', menu);
    await page.keyboard.press('Escape');
    await sun.getByRole('button', { name: '+ Task' }).click();
    const td = page.locator('.dialog', { hasText: 'New task' });
    await td.waitFor();
    check(await td.getByRole('button', { name: 'OTC', exact: true }).getAttribute('aria-pressed') === 'true', 'type OTC pre-selected');
    await td.locator('.picker input[type=search]').fill('Event Hall');
    await td.locator('.picker-item').first().waitFor();
    await td.locator('.picker-item').first().getByRole('button', { name: 'Select' }).click();
    check((await td.locator('input[type=date]').inputValue()) === sunday, 'the date is the clicked Sunday');
    await td.getByRole('button', { name: 'Create', exact: true }).click();
    await td.waitFor({ state: 'detached' });
    const sunCal = await api('GET', `/calendar?view=week&anchor=${sunday}`);
    const otc = sunCal.tasks.filter((o) => o.date === sunday && o.waste_type === 'OTC' && sunCal.customers[o.customer_id].name.startsWith('Event Hall'));
    check(otc.length === 1, `OTC task created on Sunday ${sunday}`);
    await page.waitForTimeout(300);
    check((await sun.locator('.trow', { hasText: 'Event Hall' }).count()) === 1, 'the task row shows in the Sunday column (grey pill, no colour bar)');
    // Customer without OTC: [Add OTC to this customer]
    await sun.getByRole('button', { name: '+ Task' }).click();
    await td.waitFor();
    await td.locator('.picker input[type=search]').fill('Tuas Compactor');
    await td.locator('.picker-item').first().waitFor();
    await td.locator('.picker-item').first().getByRole('button', { name: /Add OTC to this customer/ }).click();
    await td.locator('text=Change').waitFor();
    await td.getByRole('button', { name: 'Create', exact: true }).click();
    await td.waitFor({ state: 'detached' });
    const custs = await api('GET', '/customers?q=Tuas%20Compactor');
    check(custs[0] && custs[0].waste_types.includes('OTC') && custs[0].tasks.includes('OTC'), '"Add OTC to this customer" registered the type and created the task');
    await shot(page, '07-sunday');

    // 7. Task drawer: skip and restore a recurring COMPACTOR date.
    console.log('task drawer');
    // 4 tasks on that Sunday now: the group is collapsed to one line (> 3) and expands in place.
    const group = sun.locator('button.tgroup');
    check((await group.count()) === 1 && /Tasks 4/.test(await group.innerText()), 'more than 3 tasks collapse into one line', (await group.count()) && (await group.innerText()));
    if (await group.count()) await group.click();
    const comp = sun.locator('.trow', { hasText: 'Jurong' });
    if (await comp.count()) {
      await comp.first().click();
      const tdw = page.locator('.drawer');
      await tdw.getByRole('button', { name: /Menu/ }).click();
      await page.getByRole('menuitem', { name: 'Skip this date' }).click();
      await page.waitForTimeout(600);
      check(/skipped|Skipped/.test(await tdw.innerText()), 'Skip this date: the task drawer shows skipped');
      await tdw.getByRole('button', { name: /Menu/ }).click();
      await page.getByRole('menuitem', { name: 'Restore this date' }).click();
      await page.waitForTimeout(600);
      await page.keyboard.press('Escape');
    } else {
      check(false, 'recurring COMPACTOR task on Sunday found');
    }

    // 8. Month view: status on the lines and the day drawer.
    console.log('month view: statuses and the day drawer');
    await page.goto(BASE + '/');
    await page.locator('.month .mcell').first().waitFor();
    await page.getByRole('button', { name: /^Expand all/ }).click();
    const todayLines = page.locator(`.month .mcell[data-date="${today}"] .mline`);
    check((await todayLines.count()) >= 12, "Expand all: today's cell lists every route line", await todayLines.count());
    check((await page.locator(`.month .mcell[data-date="${today}"] .mline .sg.done`).count()) >= 1, 'a done job shows ✓ on its line');
    await page.getByRole('button', { name: /^Collapse all/ }).click();
    check((await todayLines.count()) <= 4, 'Collapse all: back to 4 lines');
    await page.locator(`.month .mcell[data-date="${today}"] .dnum`).click();
    await page.locator('.drawer .daydrawer .occ').first().waitFor();
    const order = await page.locator('.drawer .daydrawer .occ').evaluateAll((els) => els.map((e) => e.innerText));
    check(order.length >= 12, "today's day drawer renders the column");
    await shot(page, '08-month-day');
    await page.keyboard.press('Escape');

    // 9. Run actions and the result dialog (today).
    console.log('run actions and results');
    await page.goto(BASE + '/?view=week');
    await page.locator('.week .occ').first().waitFor();
    const tcol = page.locator(`.week .day[data-date="${today}"]`);
    if (await tcol.count()) {
      // correct a weight on N1 (done by Ali) with a reason
      await tcol.locator('.occ[data-code="N1"] .nm').click();
      const dr = page.locator('.drawer');
      await dr.locator('.stop button.sn').first().click();
      const rd = page.locator('.dialog', { hasText: 'Result ·' });
      await rd.waitFor();
      await rd.locator('.history').waitFor({ timeout: 5000 }).catch(() => {});
      await rd.locator('input[inputmode=decimal]').first().fill('123.4');
      await rd.getByRole('button', { name: 'Save', exact: true }).click();
      check(/Give a reason|why/i.test(await rd.locator('.form-error').innerText()), 'changing a result asks WHY');
      await rd.locator('input[placeholder="e.g. weighbridge recheck"]').fill('weighbridge recheck');
      await rd.getByRole('button', { name: 'Save', exact: true }).click();
      await rd.waitFor({ state: 'detached' });
      const n1 = (await occOn(today, 'N1')).occ[0];
      const v = n1.stops[0].visit;
      check(v && Number(v.weights.REL) === 123.4 && v.flags.includes('OFFICE_EDITED'), 'office correction saved with OFFICE_EDITED', v && [v.weights, v.flags]);
      await page.keyboard.press('Escape');
      // close out an unclaimed route
      const unclaimed = (await occOn(today, 'C3')).occ[0];
      if (unclaimed && unclaimed.run_status === 'not_started') {
        await tcol.locator('.occ[data-code="C3"] .nm').click();
        await page.locator('.drawer').getByRole('button', { name: 'Close out' }).click();
        await page.locator('.dialog').getByRole('button', { name: 'Close out' }).click();
        await page.waitForTimeout(800);
        const c3 = (await occOn(today, 'C3')).occ[0];
        check(c3.run_status === 'done' && c3.run && c3.run.missed === c3.stops.length, 'Close out on a not-started route: every stop missed, done', c3.run_status);
        await page.keyboard.press('Escape');
      }
      // assign a driver to an unclaimed route
      const e2 = (await occOn(today, 'E2')).occ[0];
      if (e2 && e2.run_status === 'not_started') {
        await tcol.locator('.occ[data-code="E2"] .nm').click();
        await page.locator('.drawer').getByRole('button', { name: 'Assign driver…' }).click();
        await page.locator('.dialog .drivers button', { hasText: 'Eko' }).click();
        await page.waitForTimeout(800);
        const e2b = (await occOn(today, 'E2')).occ[0];
        check(e2b.run && e2b.run.driver && e2b.run.driver.name === 'Eko', 'Assign driver: Eko holds E2', e2b.run_status);
        await page.keyboard.press('Escape');
      }
    }

    // 9b. R26: skipping today's C1 while Devi holds it with 0 done asks to release her first.
    console.log('R26 release-and-continue, photo upload');
    const c1 = (await occOn(today, 'C1')).occ[0];
    if (c1 && c1.run_status === 'active' && c1.run.collected + c1.run.missed === 0) {
      await page.locator(`.week .day[data-date="${today}"] .occ[data-code="C1"] .nm`).click();
      const dr = page.locator('.drawer');
      await dr.getByRole('button', { name: /Menu/ }).click();
      await page.getByRole('menuitem', { name: 'Skip this date' }).click();
      const re = page.locator('.dialog', { hasText: 'A driver has this job' });
      await re.waitFor();
      check(/Devi has C1 \(0 done\)/.test(await re.innerText()), 'RUN_EXISTS dialog: "Devi has C1 (0 done)"', await re.innerText());
      await re.getByRole('button', { name: 'Release the driver and continue' }).click();
      await re.waitFor({ state: 'detached' });
      await page.waitForTimeout(500);
      const c1b = (await occOn(today, 'C1')).occ[0];
      check(c1b.status === 'cancelled', 'with release_run the date is skipped', c1b.status);
      await page.keyboard.press('Escape');
    } else {
      check(false, 'C1 is held by Devi with 0 done (seed)', c1 && c1.run_status);
    }
    // E1 has work done by Bala: skip is disabled with "Bala has this job".
    await page.locator(`.week .day[data-date="${today}"] .occ[data-code="E1"] .nm`).click();
    await page.locator('.drawer').getByRole('button', { name: /Menu/ }).click();
    const skipItem = page.getByRole('menuitem', { name: 'Skip this date' });
    check((await skipItem.isDisabled()) && /Bala has this job/.test((await skipItem.getAttribute('title')) || ''), 'with work done, Skip is disabled: "Bala has this job"');
    await page.keyboard.press('Escape');
    // Office adds a photo to a result (resize + upload + reference).
    await page.locator('.drawer .stop button.sn').nth(1).click();
    const rd2 = page.locator('.dialog', { hasText: 'Result ·' });
    await rd2.waitFor();
    const jpeg = Buffer.from(
      (await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 200;
        const g = c.getContext('2d');
        g.fillStyle = '#4E79A7';
        g.fillRect(0, 0, 320, 200);
        return c.toDataURL('image/jpeg', 0.8);
      })).split(',')[1],
      'base64',
    );
    await rd2.locator('input[type=file]').setInputFiles({ name: 'bin.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await rd2.locator('.thumb img').first().waitFor({ timeout: 10000 });
    await rd2.locator('input[placeholder="e.g. weighbridge recheck"]').fill('photo added');
    await rd2.getByRole('button', { name: 'Save', exact: true }).click();
    await rd2.waitFor({ state: 'detached' });
    const e1v = (await occOn(today, 'E1')).occ[0].stops[1].visit;
    check(e1v && e1v.photos === 1, 'the photo is uploaded and referenced by the visit', e1v);
    await page.keyboard.press('Escape');

    // 9c. "This date and following" on a later date splits the route (R12 / R14, same code).
    console.log('scope: this date and following');
    let later = addDays(workDay, 7);
    for (let i = 0; i < 7; i++, later = addDays(later, 1)) {
      const o = (await occOn(later, 'W2')).occ[0];
      if (o && o.status === 'scheduled') break;
    }
    const w2Before = (await occOn(later, 'W2')).occ[0];
    await page.goto(`${BASE}/?view=week&anchor=${later}`);
    await page.locator(`.week .day[data-date="${later}"] .occ[data-code="W2"] .nm`).click();
    const dr3 = page.locator('.drawer');
    await dr3.waitFor();
    const lastCid = w2Before.stops[w2Before.stops.length - 1].customer_id;
    await dr3.locator(`.stop[data-cid="${lastCid}"]`).getByRole('button', { name: /^Remove from route/ }).click();
    check((await dr3.locator('.removed-list s').count()) === 1, 'the removed stop shows struck through');
    await dr3.getByRole('button', { name: 'Save', exact: true }).click();
    const sc = page.locator('.dialog', { hasText: 'Apply this change to' });
    await sc.locator('input[type=radio]').nth(1).check();
    await sc.getByRole('button', { name: 'Save', exact: true }).click();
    await dr3.waitFor({ state: 'detached' });
    const w2After = (await occOn(later, 'W2')).occ[0];
    const w2Earlier = (await occOn(workDay, 'W2')).occ[0];
    check(w2After.route_id !== w2Before.route_id && !w2After.stops.some((x) => x.customer_id === lastCid), `split from ${later}: a new W2 route without the customer`);
    check(!w2Earlier || w2Earlier.stops.some((x) => x.customer_id === lastCid), 'dates before the split keep the old list');

    // 9d. "+ Route" -> Regular form (clicked weekday pre-ticked); the new route's drawer opens.
    console.log('route create and task move');
    await page.goto(`${BASE}/?view=week&anchor=${workDay}`);
    const wcol = page.locator(`.week .day[data-date="${workDay}"]`);
    await wcol.locator('.occ').first().waitFor();
    await wcol.getByRole('button', { name: '+ Route' }).click();
    const items = await page.locator('.menu').innerText();
    check(/Regular · repeats weekly/.test(items) && /Adhoc · this date only/.test(items) && !/Special/.test(items), 'a work day offers Regular and ⚡ Adhoc only', items);
    await page.getByRole('menuitem', { name: 'Regular · repeats weekly' }).click();
    const rf = page.locator('.dialog', { hasText: 'New Regular route' });
    await rf.waitFor();
    check((await rf.locator('.chip[aria-pressed="true"]').count()) === 1, 'the clicked weekday is pre-ticked');
    check(/First run:/.test(await rf.innerText()), '"First run" hint');
    await rf.locator('input.code').fill('z9');
    await rf.locator('label.field', { hasText: 'Name' }).locator('input').fill('Test route');
    await rf.getByRole('button', { name: 'Create', exact: true }).click();
    await rf.waitFor({ state: 'detached' });
    const nd = page.locator('.drawer', { hasText: 'Test route' });
    await nd.waitFor({ timeout: 10000 });
    check(/Z9/.test(await nd.locator('.rd-title').innerText()), 'the new route Z9 opens in its drawer, ready for customers');
    const z9 = (await api('GET', '/routes')).find((r) => r.code === 'Z9');
    check(z9 && z9.type === 'regular' && z9.days.length === 1 && z9.start === workDay, 'created regular Z9 from the clicked date', z9);
    // OFF-2: its first customers become the route's list for every date (scope pre-selects "and following").
    await nd.getByRole('button', { name: /Add customer/ }).click();
    await nd.locator('.picker input[type=search]').fill('Golden');
    await nd.locator('.picker-item').first().click();
    await nd.getByRole('button', { name: 'Save', exact: true }).click();
    const zsc = page.locator('.dialog', { hasText: 'Apply this change to' });
    await zsc.waitFor();
    check(await zsc.locator('input[type=radio]').nth(1).isChecked(), 'new route: the scope dialog pre-selects "<date> and all following"');
    await zsc.getByRole('button', { name: 'Save', exact: true }).click();
    await nd.waitFor({ state: 'detached' });
    const z9next = (await occOn(addDays(workDay, 7), 'Z9')).occ[0];
    check(z9next && z9next.stops.length === 1 && !z9next.edited, `Z9 one week later (${addDays(workDay, 7)}) has the customer too`, z9next && z9next.stops.length);
    // Move one date of a recurring COMPACTOR task (Tuas, Tue + Fri).
    const tue = (await api('GET', `/calendar?view=week&anchor=${workDay}`)).tasks.find((o) => o.recurring && o.waste_type === 'COMPACTOR' && o.date >= workDay && o.status === 'scheduled');
    if (tue) {
      await page.goto(`${BASE}/?view=week&anchor=${tue.date}`);
      const tc = page.locator(`.week .day[data-date="${tue.date}"]`);
      await tc.locator('.occ').first().waitFor();
      if (await tc.locator('button.tgroup').count()) await tc.locator('button.tgroup').click();
      await tc.locator(`.trow[data-key="${tue.key}"]`).click();
      await page.locator('.drawer').getByRole('button', { name: /Menu/ }).click();
      await page.getByRole('menuitem', { name: 'Move this date…' }).click();
      const mv = page.locator('.dialog', { hasText: 'Move this date' });
      await mv.locator('input[type=date]').fill(addDays(tue.date, 1));
      check(await mv.locator('input[type=checkbox]').isChecked(), '"Skip the original" is ticked for a runnable recurring date');
      await mv.getByRole('button', { name: 'Copy', exact: true }).click();
      await mv.waitFor({ state: 'detached' });
      const cal2 = await api('GET', `/calendar?view=week&anchor=${tue.date}`);
      const src = cal2.tasks.find((o) => o.key === tue.key);
      const moved = cal2.tasks.find((o) => o.date === addDays(tue.date, 1) && o.customer_id === tue.customer_id && !o.recurring);
      check(src && src.status === 'cancelled' && src.covered_by.length === 1 && moved, 'Move this date: source skipped ("→ date") and a one-off on the new date');
      await page.keyboard.press('Escape');
    } else {
      check(false, 'a recurring COMPACTOR date found');
    }

    // 10. Routes and Tasks pages.
    console.log('routes and tasks pages');
    await page.goto(BASE + '/routes');
    await page.locator('table tbody tr').first().waitFor();
    check((await page.locator('table tbody tr').count()) >= 19, 'Routes page lists the routes');
    await page.locator('table tbody tr', { hasText: 'North 2' }).first().click();
    await page.locator('.drawer .stoplist .stop').first().waitFor();
    check((await page.locator('.drawer .stoplist .stop').count()) >= 6, 'template editor shows the stop list');
    await page.keyboard.press('Escape');
    await page.goto(BASE + '/tasks');
    await page.locator('table tbody tr').first().waitFor();
    check((await page.locator('table tbody tr').count()) >= 8, 'Tasks page lists the tasks');

    // The browser logs every non-2xx response; the 409 RUN_EXISTS above is expected.
    const real = consoleErrors.filter((e) => !/status of 409/.test(e));
    check(real.length === 0, 'no console errors', real.slice(0, 3));
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
    for (const p of procs) if (p.output) console.error(p.output.slice(-2000));
  })
  .finally(() => {
    stopAll();
    if (!process.env.KEEP_DATA) fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
