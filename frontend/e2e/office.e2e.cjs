// End-to-end test of the office calendar (M3–M7 office side, Round 5 month view) at 1440×1000.
// Starts its own backend (php -S) and Vite, seeds demo data through the API (scripts/seed-demo.mjs,
// with live runs), drives Chromium with Playwright and checks every result through the API, then stops both.
//
//   cd frontend && node e2e/office.e2e.cjs        (or: npm run e2e:office)
//
// Env (defaults): BACKEND_PORT=8281  FRONT_PORT=5281  WMS_DATA_DIR=/tmp/wms-test-office
//                 E2E_SHOTS=<dir> to save screenshots   KEEP_DATA=1 to keep the data dir
//                 WMS_FAKE_NOW=<ISO 8601 time> pins the server clock; CI uses 2026-11-11T10:00:00+08:00
// Dates are taken from the server (today, next work day, the next Mon–Sat PH, the next Sunday), so the
// test works on any Mon–Sat work day: today must have the seeded live runs, so it fails on a Sunday or a PH
// (CI pins WMS_FAKE_NOW). The data dir is WIPED at the start (and at the end unless KEEP_DATA=1).
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
/** The error code of a call that must be refused (null when it went through). */
async function apiCode(method, p, body, tok = token) {
  const r = await fetch(API + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = r.status === 204 ? { ok: true } : await r.json();
  return j.ok ? null : j.error?.code;
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

const BLUE = 'rgb(0, 105, 162)'; // --cal-today (light theme, the default "jiangshan" look)
const RED = 'rgb(147, 63, 52)'; // --cal-ph (light theme, the default "jiangshan" look)
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Month view checks (§9.2, Round 5). Leaves tomorrow's first regular route edited (only that date) and an
 *  extra adhoc route on tomorrow, plus one adhoc route on workDay. */
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
  // Round 7: every route line carries its waste-type tag; the day's totals count the drivers' free
  // submissions (the seed made an OTC and a COMPACTOR one), which have no line on the calendar.
  await page.getByRole('button', { name: /^Expand all/ }).click();
  const tagOf = async (code) => (await page.locator(`.month .mcell[data-date="${today}"] .mline[data-code="${code}"] .wtag`).allInnerTexts()).join();
  check((await tagOf('N1')) === '' && (await tagOf('R1')) === 'RCY', 'route lines show the waste-type tag only when it is not REL: N1 none, R1 RCY', [await tagOf('N1'), await tagOf('R1')]);
  // The code's colour is the route's progress (not which route it is): the tone the API data gives.
  const lineOf = (code) => page.locator(`.month .mcell[data-date="${today}"] .mline[data-code="${code}"]`);
  const toneOf = (o) => {
    if (o.status !== 'scheduled') return null;
    const r = o.run;
    if ((r && r.missed > 0) || ['incomplete', 'no_record', 'open'].includes(o.run_status)) return 'problem';
    if (o.run_status === 'done') return 'done';
    if (o.run_status === 'active') return r && r.total > 0 && (r.collected + r.missed) * 2 >= r.total ? 'late' : 'early';
    return 'idle';
  };
  const TONE_BG = { idle: 'rgb(72, 102, 112)', early: 'rgb(125, 94, 19)', late: 'rgb(0, 105, 162)', done: 'rgb(59, 107, 52)', problem: 'rgb(147, 63, 52)' };
  const todayOcc = mcal.routes.filter((o) => o.date === today && o.status === 'scheduled');
  const shown = [];
  for (const o of todayOcc) {
    shown.push([o.code, toneOf(o), await lineOf(o.code).getAttribute('data-tone'), await lineOf(o.code).locator('.code').evaluate((e) => getComputedStyle(e).backgroundColor)]);
  }
  check(shown.length >= 8 && shown.every(([, want, tone, bg]) => tone === want && bg === TONE_BG[want]), "the code's colour is the route's progress, the same for every route in that state", shown.filter(([, want, tone, bg]) => tone !== want || bg !== TONE_BG[want]));
  check(new Set(shown.map((x) => x[1])).size >= 2, 'today shows at least two different states', [...new Set(shown.map((x) => x[1]))]);
  check((await page.locator('[data-testid=tone-key] span').count()) === 5 && (await page.locator('.legend, .lchip').count()) === 0, 'a key explains the five colours; there is no list of route codes above the calendar');
  // Two looks, switched in the header and remembered in this browser.
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const look = page.locator('[data-testid=style-switch] button');
  check((await bodyBg()) === 'rgb(242, 248, 252)' && (await look.first().getAttribute('aria-pressed')) === 'true', 'the default look is the Jiangshan palette (pale blue ground)', await bodyBg());
  await look.nth(1).click();
  check((await bodyBg()) === 'rgb(245, 246, 248)' && (await lineOf(shown[0][0]).locator('.code').evaluate((e) => getComputedStyle(e).backgroundColor)) !== shown[0][3], 'the second button switches to the plain look (also the progress colours)', await bodyBg());
  await page.reload();
  await page.locator(`.month .mcell[data-date="${today}"] .mline`).first().waitFor();
  check((await bodyBg()) === 'rgb(245, 246, 248)', 'the look is remembered after a reload');
  await page.locator('[data-testid=style-switch] button').first().click();
  check((await bodyBg()) === 'rgb(242, 248, 252)', 'and switches back');
  await page.getByRole('button', { name: /^Expand all/ }).click().catch(() => {});
  check((await lineOf('N1').locator('.tt').count()) === 0, 'a regular route line has no R tag');
  const todayCal = mcal.days.find((d) => d.date === today);
  check(todayCal.totals.OTC === 300 && todayCal.totals.COMPACTOR === 1250, "API: today's totals count the free submissions (OTC 300, COMPACTOR 1250)", todayCal.totals);
  check(/OTC 300 kg/.test(await tTot.innerText()) && /COMPACTOR 1,250 kg/.test(await tTot.innerText()), "today's cell totals show OTC and COMPACTOR too", await tTot.innerText());
  check(mcal.tasks === undefined && (await page.locator('.month .mline.task, .trow, .tgroup').count()) === 0, 'the calendar has no tasks and no task lines');
  check((await page.getByRole('link', { name: 'Tasks' }).count()) === 0 && (await page.getByRole('link', { name: 'Submissions' }).count()) === 1, 'the menu has Submissions and no Tasks page');
  await page.getByRole('button', { name: /^Collapse all/ }).click();
  await shot(page, '00-month');

  // A day with more than 4 lines: 4 + "N more"; expand / collapse in place; a refetch keeps it open.
  await page.goto(`${BASE}/?anchor=${tomorrow}`);
  const cell = page.locator(`.month .mcell[data-date="${tomorrow}"]`);
  await cell.locator('.mline').first().waitFor();
  const lines = cell.locator('.mline');
  const occ = async () => {
    const c = await api('GET', `/calendar?view=week&anchor=${tomorrow}&week_start=sun`);
    return c.routes.filter((o) => o.date === tomorrow && o.status !== 'holiday_skipped');
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
  const relCust = (await api('GET', '/customers?type=REL'))[0];
  const refCode = (await api('GET', `/routes/suggest-code?type=adhoc&date=${tomorrow}`)).code;
  await api('POST', '/routes', { type: 'adhoc', waste_type: 'REL', code: refCode, name: 'e2e month refetch', note: '', date: tomorrow, stops: [{ customer_id: relCust.id, note: '' }] });
  const resp = page.waitForResponse((r) => r.url().includes('/api/calendar') && r.status() === 200, { timeout: 40000 });
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await resp;
  // The response caught above can be a poll that left before the new route was saved: wait for the line
  // itself (the next refetch at the latest), then check that the cell is still expanded.
  await lines.nth(n).waitFor({ timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(400);
  check((await lines.count()) === n + 1 && (await cell.locator('.mmore', { hasText: 'Show less' }).count()) === 1, 'after a refetch the cell stays expanded and shows the new route', await lines.count());
  await cell.locator('.mmore').click();
  check((await lines.count()) === 4 && /more ▾/.test(await cell.locator('.mmore').innerText()), '"Show less" collapses it again');
  // Expand all / Collapse all
  await page.getByRole('button', { name: /^Expand all/ }).click();
  check((await page.locator('.month .mmore[aria-expanded="false"]').count()) === 0 && (await lines.count()) === n + 1, 'Expand all opens every cell');
  await page.getByRole('button', { name: /^Collapse all/ }).click();
  check((await page.locator('.month .mmore[aria-expanded="true"]').count()) === 0 && (await lines.count()) === 4, 'Collapse all closes them');

  // Clicking a route line opens its drawer; the stop list is editable (↓, save only this date).
  const line = cell.locator('.mline:not(.adhoc)').first();
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
  check(/Regular · repeats weekly/.test(menu) && /Adhoc · this date only/.test(menu) && !/Task/.test(menu) && !/Special/.test(menu), '"+" offers the day\'s route kinds only (nothing is planned for OTC / COMPACTOR / EROSE)', menu);
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

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "20 Nov" (the office's short English date). */
const short = (d) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
async function poll(page, fn, ms = 6000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await page.waitForTimeout(100);
  }
  return v;
}
/** The first date >= from (up to 3 weeks) on which `code` is scheduled. */
async function scheduledOn(code, from, before = null) {
  let d = from;
  for (let i = 0; i < 21; i++, d = addDays(d, 1)) {
    if (before && d >= before) return null;
    const o = (await occOn(d, code)).occ[0];
    if (o && o.status === 'scheduled') return d;
  }
  return null;
}

/**
 * A split route is one route in the office's forms and dialogs (K2, K3, K4, K5, SPLIT-UI-03..12). K1 is split
 * by a schedule change; E1 (Bala, work done today) is released by the office and split too.
 */
async function splitRouteChecks(page, { today, consoleErrors }) {
  console.log('split route: one route in the forms and dialogs');
  const k1 = (await api('GET', '/routes')).find((r) => r.code === 'K1');
  const split = await scheduledOn('K1', addDays(today, 8));
  await api('POST', `/routes/${k1.id}/change-schedule`, { rev: k1.rev, from: split, days: k1.days });
  const before = await scheduledOn('K1', addDays(today, 1), split);
  const after = await scheduledOn('K1', addDays(split, 1));
  const k1Segs = async () => (await api('GET', '/routes')).filter((r) => r.code === 'K1').sort((a, b) => a.start.localeCompare(b.start));
  check((await k1Segs()).length === 2, `K1 split at ${split} (two route records)`);
  const openK1 = async (date) => {
    await page.goto(`${BASE}/?view=week&anchor=${date}`);
    await page.locator(`.week .day[data-date="${date}"] .occ[data-code="K1"] .nm`).click();
    const dr = page.locator('.drawer');
    await dr.locator('.rd-rule').waitFor();
    return dr;
  };
  const openForm = async (dr) => {
    await dr.getByRole('button', { name: /Menu/ }).click();
    await page.getByRole('menuitem', { name: 'Edit route / schedule…' }).click();
    const rf = page.locator('.dialog', { hasText: 'Edit route K1' });
    await rf.locator('form').waitFor();
    return rf;
  };
  const formDates = (rf) => rf.locator('label.field input[type=date]').evaluateAll((els) => els.map((e) => e.value));

  // K3 / SPLIT-UI-04: opened from the later part, the header and the form show the route's real start.
  let dr = await openK1(after);
  const rule = await poll(page, async () => {
    const x = await dr.locator('.rd-rule').innerText();
    return x.includes(`from ${short(k1.start)}`) ? x : null;
  });
  check(!!rule && !/until/.test(rule), `K3: the header of ${after} reads "from ${short(k1.start)}" (the route's start), no "until"`, rule || (await dr.locator('.rd-rule').innerText()));
  let rf = await openForm(dr);
  const [st, en] = await formDates(rf);
  check(st === k1.start && en === '', `K3: Edit route / schedule shows Start ${k1.start} and no End (not the part's ${split})`, [st, en]);

  // K4 / SPLIT-UI-11: another clerk renames K1 while this form is open; the form keeps only its own change.
  await rf.locator('label.field', { hasText: 'Note' }).locator('textarea').fill('clerk 1 note');
  const segs0 = await k1Segs();
  await api('PATCH', `/routes/${segs0[0].id}`, { rev: segs0[0].rev, name: 'Kallang (clerk 2)' });
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.locator('.form-error').waitFor();
  check(/Someone else changed this/.test(await rf.locator('.form-error').innerText()), 'K4: the first Save is refused (STALE_REVISION)');
  const nameIn = rf.locator('label.field', { hasText: 'Name' }).locator('input');
  const reloaded = await poll(page, async () => (await nameIn.inputValue()) === 'Kallang (clerk 2)');
  check(reloaded, "K4: the untouched Name now shows the other clerk's value", await nameIn.inputValue());
  const banner = rf.locator('[data-testid=changed-meanwhile]');
  check((await banner.count()) === 1 && /Name/.test(await banner.innerText()), 'K4: a banner names what the other clerk changed', (await banner.count()) && (await banner.innerText()));
  check((await rf.locator('label.field', { hasText: 'Note' }).locator('textarea').inputValue()) === 'clerk 1 note', 'K4: the own change (note) is kept');
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  const segs1 = await k1Segs();
  check(segs1.every((r) => r.name === 'Kallang (clerk 2)' && r.note === 'clerk 1 note'), "K4: the second Save keeps the other clerk's name on every part and adds the note", segs1.map((r) => [r.name, r.note]));
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });

  // SPLIT-UI-05: opened from the earlier part, no "until" (the split boundary is not the route's end); Save
  // with nothing changed writes nothing.
  dr = await openK1(before);
  const rule2 = await poll(page, async () => {
    const x = await dr.locator('.rd-rule').innerText();
    return !/until/.test(x) ? x : null;
  });
  check(!!rule2, `SPLIT-UI-05: the header of ${before} has no "until ${short(addDays(split, -1))}"`, rule2 || (await dr.locator('.rd-rule').innerText()));
  rf = await openForm(dr);
  const [st2, en2] = await formDates(rf);
  check(st2 === k1.start && en2 === '', 'SPLIT-UI-05: End is empty on the earlier part', [st2, en2]);
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  const segs2 = await k1Segs();
  check(JSON.stringify(segs2.map((r) => [r.id, r.rev, r.start, r.end])) === JSON.stringify(segs1.map((r) => [r.id, r.rev, r.start, r.end])), 'SPLIT-UI-05: saving it unchanged writes nothing', segs2.map((r) => [r.rev, r.start, r.end]));
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });

  // K2 / SPLIT-UI-03: the delete dialog names both parts.
  dr = await openK1(after);
  await dr.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('menuitem', { name: 'Delete route…' }).click();
  const del = page.locator('.dialog', { hasText: 'Delete route K1' });
  const delText = await poll(page, async () => {
    const x = await del.locator('[data-testid=delete-text]').innerText();
    return /runs as 2 schedules/.test(x) ? x : null;
  });
  check(!!delText && delText.includes(`from ${short(split)}`) && delText.includes(short(k1.start)), 'K2: "Delete route K1?" says both schedules are deleted', delText);
  await del.getByRole('button', { name: 'Cancel' }).click();

  // SPLIT-UI-12: an End error shows only in the End dialog and is gone after Cancel.
  const errsBefore = consoleErrors.length;
  await dr.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('menuitem', { name: 'End route from date…' }).click();
  const endDlg = page.locator('.dialog', { hasText: 'End route K1' });
  await endDlg.locator('input[type=date]').fill(addDays(today, -5));
  await endDlg.getByRole('button', { name: 'End', exact: true }).click();
  await endDlg.locator('.form-error').waitFor();
  check((await dr.locator('.form-error').count()) === 0, 'SPLIT-UI-12: the End error shows in the dialog only, not also in the drawer footer');
  await endDlg.getByRole('button', { name: 'Cancel' }).click();
  await endDlg.waitFor({ state: 'detached' });
  check((await dr.locator('.form-error').count()) === 0, 'SPLIT-UI-12: after Cancel the drawer footer has no stale error');
  consoleErrors.splice(errsBefore, consoleErrors.length - errsBefore, ...consoleErrors.slice(errsBefore).filter((e) => !/status of 422/.test(e)));
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });

  // SPLIT-UI-06: opened on the split date itself, "From date" (pre-filled with it) changes the schedule from
  // that date (no "must start after the route starts"): K1 stops running on Fridays from the split on.
  dr = await openK1(split);
  rf = await openForm(dr);
  await rf.getByRole('button', { name: 'Fri', exact: true }).click();
  await rf.locator('input[type=radio]').nth(1).check();
  check((await rf.locator('input[aria-label="From date"]').inputValue()) === split, `SPLIT-UI-06: "From date" is pre-filled with ${split}`);
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  const saved06 = await rf.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false);
  check(saved06, 'SPLIT-UI-06: the schedule change from the split date is saved', saved06 ? '' : await rf.locator('.form-error').innerText());
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });
  const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  let friAfter = split;
  while (dow(friAfter) !== 5) friAfter = addDays(friAfter, 1);
  let friBefore = addDays(today, 1);
  while (dow(friBefore) !== 5) friBefore = addDays(friBefore, 1);
  const kAfter = (await occOn(friAfter, 'K1')).occ.length;
  const kBefore = (await occOn(friBefore, 'K1')).occ.length;
  check(kAfter === 0 && (friBefore >= split || kBefore === 1), `SPLIT-UI-06: no K1 on Fri ${friAfter}; Fri ${friBefore} (before the split) keeps it`, { kAfter, kBefore });

  // SPLIT-UI-08: the Routes page keeps the two K1 rows together as parts of one route.
  await page.goto(BASE + '/routes');
  await page.locator('table tbody tr').first().waitFor();
  await page.locator('input.search').fill('K1');
  const rows = page.locator('table tbody tr[data-code="K1"]');
  const parts = await rows.locator('[data-testid=part]').allInnerTexts();
  check(parts.join('|') === 'part 1 of 2|part 2 of 2', 'SPLIT-UI-08: the K1 rows read "part 1 of 2", "part 2 of 2"', parts);
  // SPLIT-7: every part shows the route's next date (part 1 may have none of its own left).
  const nextCells = await rows.locator('td:nth-child(7)').allInnerTexts();
  const k1Next = (await api('GET', '/routes')).find((r) => r.code === 'K1').route_next_date;
  check(nextCells.length === 2 && nextCells[0] === nextCells[1] && !!k1Next && nextCells[0] !== '–', "SPLIT-7: both K1 rows show the route's next date", { nextCells, k1Next });
  await rows.first().click();
  const tnote = page.locator('.drawer [data-testid=template-note]');
  await tnote.waitFor();
  const tn = await poll(page, async () => {
    const x = await tnote.innerText();
    return x.includes(`from ${short(split)}`) ? x : null;
  });
  check(!!tn, 'SPLIT-UI-08: the customer-list editor names the other part\'s dates', tn || (await tnote.innerText()));
  await page.keyboard.press('Escape');
  await rows.nth(1).locator('td.actions button').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const del2 = page.locator('.dialog', { hasText: 'Delete route K1' });
  check(/runs as 2 schedules/.test(await del2.locator('[data-testid=delete-text]').innerText()), 'K2: the Routes page delete dialog names both parts too', await del2.locator('[data-testid=delete-text]').innerText());
  await del2.getByRole('button', { name: 'Cancel' }).click();

  // K5 / SPLIT-UI-09: the office takes E1 back from Bala (3 done): "taken back by office".
  const e1 = (await occOn(today, 'E1')).occ[0];
  if (e1 && e1.run && e1.run.driver && e1.run.collected + e1.run.missed > 0) {
    await api('POST', `/runs/${today}/r${e1.route_id}/release`, { mark_missed: false });
    await page.goto(`${BASE}/?view=week&anchor=${today}`);
    await page.locator(`.week .day[data-date="${today}"] .occ[data-code="E1"] .nm`).click();
    const box = await page.locator('.drawer .status-box').innerText();
    check(/Needs driver · taken back by office · \d+\/\d+/.test(box), 'K5: the drawer reads "Needs driver · taken back by office · n/m"', box);
    const tip = await page.locator(`.week .day[data-date="${today}"] .occ[data-code="E1"] .sg`).getAttribute('title');
    check(/taken back by office/.test(tip || ''), 'K5: the week row tooltip says it too', tip);
    await page.keyboard.press('Escape');
    // SPLIT-UI-10: deleting E1 from a later part is refused; the dialog names the work done, not "nobody".
    const e1r = (await api('GET', '/routes')).find((r) => r.code === 'E1');
    await api('POST', `/routes/${e1r.id}/change-schedule`, { rev: e1r.rev, from: split, days: e1r.days });
    await page.goto(`${BASE}/?view=week&anchor=${after}`);
    await page.locator(`.week .day[data-date="${after}"] .occ[data-code="E1"] .nm`).click();
    await page.locator('.drawer').getByRole('button', { name: /Menu/ }).click();
    await page.getByRole('menuitem', { name: 'Delete route…' }).click();
    await page.locator('.dialog', { hasText: 'Delete route E1' }).getByRole('button', { name: 'Delete', exact: true }).click();
    const re = page.locator('.dialog', { hasText: 'Work is already done on this job today' });
    await re.waitFor();
    const reText = await re.innerText();
    check(/Refused: \d+ stops of E1 are already done today/.test(reText) && !/nobody/.test(reText), 'SPLIT-UI-10: "Refused: n stops of E1 are already done today", not "nobody has done"', reText);
    await re.getByRole('button', { name: 'Close', exact: true }).last().click();
    check((await occOn(after, 'E1')).occ.length === 1, 'E1 is not deleted');
    await page.keyboard.press('Escape');
  } else {
    check(false, 'E1 is held by Bala with work done (seed)', e1 && e1.run);
  }
}

/**
 * Round 8: a customer of a regular route may be collected on some of the route's weekdays only. The route here
 * starts next Monday, so today's routes are not touched.
 */
async function stopDaysChecks(page, { today }) {
  console.log('stop weekdays: a customer collected on some of the route days');
  let mon = addDays(today, 1);
  while (new Date(mon + 'T00:00:00Z').getUTCDay() !== 1) mon = addDays(mon, 1);
  const tue = addDays(mon, 1);
  const [A, B, C] = (await api('GET', '/customers')).filter((c) => c.active !== false && c.waste_types.includes('REL'));
  const sd = await api('POST', '/routes', {
    waste_type: 'REL',
    type: 'regular',
    code: 'SD1',
    name: 'Stop days route',
    start: mon,
    days: [1, 2, 3, 4, 5, 6],
    stops: [{ customer_id: A.id, note: '', days: [1, 3, 5] }, { customer_id: B.id, note: '' }],
  });
  const nMon = (await occOn(mon, 'SD1')).occ[0]?.stops.length;
  const nTue = (await occOn(tue, 'SD1')).occ[0]?.stops.length;
  check(nMon === 2 && nTue === 1, `SD1 has 2 stops on Monday ${mon} and 1 on Tuesday ${tue}`, [nMon, nTue]);

  // The template editor: the label, the control and the per-weekday counts.
  await page.goto(BASE + '/routes');
  await page.locator('table tbody tr', { hasText: 'Stop days route' }).first().click();
  const te = page.locator('.drawer');
  const rowA = te.locator(`.stop[data-cid="${A.id}"]`);
  await rowA.waitFor();
  check((await rowA.locator('[data-testid=stop-days]').innerText()) === 'Mon Wed Fri', 'template editor: the stop shows its weekdays "Mon Wed Fri"');
  check((await te.locator(`.stop[data-cid="${B.id}"] [data-testid=stop-days]`).count()) === 0, 'a stop collected on every route day shows no weekday label');
  await rowA.getByRole('button', { name: /^Collection weekdays/ }).click();
  check((await rowA.locator('.chip').count()) === 6 && (await rowA.locator('.chip[aria-pressed="true"]').count()) === 3, 'Collection weekdays: one chip per route day, the stop\'s days pressed');
  await rowA.getByRole('button', { name: 'Fri', exact: true }).click();
  const counts = await te.locator('[data-testid=day-counts]').innerText();
  check(counts === 'Mon 2 · Tue 1 · Wed 2 · Thu 1 · Fri 1 · Sat 1', 'the header counts the stops per weekday', counts);
  await shot(page, '50-stop-days-template');
  await te.getByRole('button', { name: 'Save', exact: true }).click();
  await te.waitFor({ state: 'detached' });
  let stored = (await api('GET', `/routes/${sd.id}`)).stops;
  check(JSON.stringify(stored[0].days) === '[1,3]' && !('days' in stored[1]), 'saved: the stop is collected on Mon Wed', stored);

  // The date drawer on Tuesday: a customer added "and all following" keeps A on the route, on its own days.
  await page.goto(`${BASE}/?view=week&anchor=${tue}`);
  await page.locator(`.week .day[data-date="${tue}"] .occ[data-code="SD1"] .nm`).click();
  const dr = page.locator('.drawer');
  await dr.locator('.rd-rule').waitFor();
  check((await dr.locator('.stop').count()) === 1 && (await dr.locator('[data-testid=stop-days]').count()) === 0, 'Tuesday drawer: only the customer due that day, no weekday label');
  await dr.getByRole('button', { name: /Add customer/ }).click();
  await dr.locator('.picker input[type=search]').fill(C.code);
  await dr.locator('.picker-item', { hasText: C.code }).first().click();
  await dr.getByRole('button', { name: 'Save', exact: true }).click();
  const sc = page.locator('.dialog', { hasText: 'Apply this change to' });
  await sc.waitFor();
  await page.waitForTimeout(1500); // the route has loaded: the default no longer changes
  check(await sc.locator('input[type=radio]').first().isChecked(), 'scope dialog defaults to "Only <date>" on a route that has its list');
  await sc.locator('input[type=radio]').nth(1).check();
  await sc.getByRole('button', { name: 'Save', exact: true }).click();
  await dr.waitFor({ state: 'detached' });
  const tueOcc = (await occOn(tue, 'SD1')).occ[0];
  stored = (await api('GET', `/routes/${tueOcc.route_id}`)).stops;
  const a = stored.find((x) => x.customer_id === A.id);
  check(
    !!a && JSON.stringify(a.days) === '[1,3]' && stored.length === 3 && tueOcc.stops.map((x) => x.customer_id).join() === [B.id, C.id].join(),
    'Tuesday and all following: the customer due on Mon Wed stays on the route with its days',
    { stored, tue: tueOcc.stops.map((x) => x.customer_id) },
  );

  // The scope dialog names each customer that gains or loses the weekday, and the save does what it says.
  const openTue = async (code) => {
    await page.goto(`${BASE}/?view=week&anchor=${tue}`);
    await page.locator(`.week .day[data-date="${tue}"] .occ[data-code="${code}"] .nm`).click();
    await dr.locator('.rd-rule').waitFor();
  };
  const addTo = async (c) => {
    await dr.getByRole('button', { name: /Add customer/ }).click();
    await dr.locator('.picker input[type=search]').fill(c.code);
    await dr.locator('.picker-item', { hasText: c.code }).first().click();
  };
  /** Saves the drawer "and all following"; returns the dialog's per-customer lines and A's stored weekdays. */
  const followingLines = async () => {
    await dr.getByRole('button', { name: 'Save', exact: true }).click();
    await sc.waitFor();
    const before = await sc.locator('[data-testid=day-effect]').count();
    await sc.locator('input[type=radio]').nth(1).check();
    const lines = await poll(page, async () => {
      const x = await sc.locator('[data-testid=day-effect]').allInnerTexts();
      return x.length ? x : null;
    });
    await sc.getByRole('button', { name: 'Save', exact: true }).click();
    await dr.waitFor({ state: 'detached' });
    const list = (await api('GET', `/routes/${(await occOn(tue, 'SD1')).occ[0].route_id}`)).stops;
    return { before, lines, days: list.find((x) => x.customer_id === A.id)?.days };
  };
  await openTue('SD1');
  await addTo(A);
  let fx = await followingLines();
  check(
    fx.before === 0 && JSON.stringify(fx.lines) === JSON.stringify([`${A.name}: Mon Wed, now also Tue`]) && JSON.stringify(fx.days) === '[1,2,3]',
    'scope dialog, "all following": the customer added on Tuesday is named with its other days, and gains Tuesday',
    fx,
  );
  await openTue('SD1');
  await dr.locator(`.stop[data-cid="${A.id}"]`).getByRole('button', { name: /^Remove from route/ }).click();
  fx = await followingLines();
  check(
    fx.before === 0 && JSON.stringify(fx.lines) === JSON.stringify([`${A.name}: no longer on Tue, still Mon Wed`]) && JSON.stringify(fx.days) === '[1,3]',
    'scope dialog, "all following": the customer removed on Tuesday is named, and keeps its other days',
    fx,
  );

  // A date with no customer due, on a route that has customers on other weekdays: the default is "Only <date>".
  const sd2 = await api('POST', '/routes', {
    waste_type: 'REL',
    type: 'regular',
    code: 'SD2',
    name: 'Stop days empty day',
    start: mon,
    days: [1, 2, 3, 4, 5, 6],
    stops: [{ customer_id: A.id, note: '', days: [1] }],
  });
  await openTue('SD2');
  check((await dr.locator('.stop').count()) === 0, 'SD2 on Tuesday: no customer is due');
  await addTo(B);
  await dr.getByRole('button', { name: 'Save', exact: true }).click();
  await sc.waitFor();
  const scSave = sc.getByRole('button', { name: 'Save', exact: true });
  await poll(page, () => scSave.isEnabled()); // Save waits for the route: the default depends on its standing list
  check(await sc.locator('input[type=radio]').first().isChecked(), 'scope dialog defaults to "Only <date>" on an empty date of a route that has customers on other weekdays');
  await scSave.click();
  await dr.waitFor({ state: 'detached' });
  stored = (await api('GET', `/routes/${sd2.id}`)).stops;
  const tue2 = (await occOn(tue, 'SD2')).occ[0];
  check(stored.length === 1 && tue2.edited && tue2.stops.map((x) => x.customer_id).join() === String(B.id), 'saved for that Tuesday only: the standing list is unchanged', { stored, tue2 });
  // Edit route: Monday removed and saved; the warning is shown after the save.
  await openTue('SD2');
  await dr.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('menuitem', { name: 'Edit route / schedule…' }).click();
  const rf2 = page.locator('.dialog', { hasText: 'Edit route SD2' });
  await rf2.locator('form').waitFor();
  await rf2.getByRole('button', { name: 'Mon', exact: true }).click();
  await rf2.locator('[data-testid=days-reset]').waitFor();
  await rf2.getByRole('button', { name: 'Save', exact: true }).click();
  const warnToast = page.locator('.toast.warn');
  const toastText = await warnToast.first().waitFor({ timeout: 10000 }).then(() => warnToast.first().innerText(), () => null);
  check(toastText === "Some customers' collection weekdays no longer fit the route. They are now collected every day the route runs.", 'Edit route saved: the weekday reset is shown as a warning', toastText);
  stored = (await api('GET', `/routes/${sd2.id}`)).stops;
  check(stored.length === 1 && !('days' in stored[0]), 'the customer whose only weekday left the route is collected every day', stored);
  await rf2.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });

  // Edit route / schedule: removing Monday and Wednesday names the customer before the save.
  await page.goto(`${BASE}/?view=week&anchor=${tue}`);
  await page.locator(`.week .day[data-date="${tue}"] .occ[data-code="SD1"] .nm`).click();
  await dr.locator('.rd-rule').waitFor();
  await dr.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('menuitem', { name: 'Edit route / schedule…' }).click();
  const rf = page.locator('.dialog', { hasText: 'Edit route SD1' });
  await rf.locator('form').waitFor();
  check((await rf.locator('[data-testid=days-reset]').count()) === 0, 'Edit route: no weekday notice before a change');
  await rf.getByRole('button', { name: 'Mon', exact: true }).click();
  check((await rf.locator('[data-testid=days-reset]').count()) === 0, 'Monday removed: the customer still has Wednesday, no notice');
  await rf.getByRole('button', { name: 'Wed', exact: true }).click();
  const note = await poll(page, async () => {
    const x = await rf.locator('[data-testid=days-reset]').allInnerTexts();
    return x.length ? x[0] : null;
  });
  check(!!note && note.endsWith(`every day the route runs: ${A.name}`), 'Monday and Wednesday removed: the notice names the customer whose weekdays are reset', note);
  await shot(page, '51-stop-days-reset');
  await rf.getByRole('button', { name: 'Cancel', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await dr.waitFor({ state: 'detached' });
}

/**
 * Round 6 (§6.5): a later part of a split route keeps its own planned change (Tue Thu from D2, a customer added
 * from D1); only what the clerk changes reaches it. Edit route / schedule, the scope dialog and the template
 * editor say so before the save, and each notice is compared with what the server stored, read back over the API.
 */
async function keptPlanChecks(page, { today }) {
  console.log('split route: what a later part keeps is named before the save');
  const WD = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay() || 7;
  const long = (d) => `${WD[dowOf(d)]} ${short(d)}`;
  const daysText = (days) => days.map((d) => WD[d]).join(' ');
  const nextDow = (from, days) => {
    let d = from;
    while (!days.includes(dowOf(d))) d = addDays(d, 1);
    return d;
  };
  const when = (p) => (p.end && p.start <= today ? `until ${long(p.end)}` : p.end ? `from ${long(p.start)} to ${long(p.end)}` : `from ${long(p.start)}`);
  const custs = (await api('GET', '/customers')).filter((c) => c.active !== false && c.waste_types.includes('REL'));
  const [A, B, C, D] = custs;
  const nameOf = (id) => custs.find((c) => c.id === id).name;
  const S = (...cs) => cs.map((c) => ({ customer_id: c.id, note: '' }));
  /** The notice for a part whose stored list (after the save) differs from the saved list, built from the API. */
  const listNotice = (part, saved) => {
    const ids = part.stops.map((s) => s.customer_id);
    const also = ids.filter((x) => !saved.includes(x)).map(nameOf).join(', ');
    const lacks = saved.filter((x) => !ids.includes(x)).map(nameOf).join(', ');
    if (!also && !lacks) return null;
    const diff = also && lacks ? `It also has ${also} and does not have ${lacks}.` : also ? `It also has ${also}.` : `It does not have ${lacks}.`;
    return `Already planned ${when(part)}: that part keeps its own list. ${diff}`;
  };
  const openDrawer = async (code, date) => {
    await page.goto(`${BASE}/?view=week&anchor=${date}`);
    await page.locator(`.week .day[data-date="${date}"] .occ[data-code="${code}"] .nm`).click();
    const dr = page.locator('.drawer');
    await dr.locator('.rd-rule').waitFor();
    return dr;
  };
  const openEdit = async (code, date) => {
    const dr = await openDrawer(code, date);
    await dr.getByRole('button', { name: /Menu/ }).click();
    await page.getByRole('menuitem', { name: 'Edit route / schedule…' }).click();
    const rf = page.locator('.dialog', { hasText: `Edit route ${code}` });
    await rf.locator('form').waitFor();
    return { dr, rf };
  };
  const notes = (loc, id) => poll(page, async () => {
    const x = await loc.locator(`[data-testid=${id}]`).allInnerTexts();
    return x.length ? x : null;
  });
  const closeAll = async (dr) => {
    await page.keyboard.press('Escape');
    await dr.waitFor({ state: 'detached' });
  };

  // KP1 runs Mon Wed Fri from today; from D1 it is a part with its own list; from D2 it runs Tue Thu (planned).
  const D1 = nextDow(addDays(today, 14), [1, 3, 5]);
  const D2 = nextDow(addDays(D1, 14), [1, 3, 5]);
  const kp1 = await api('POST', '/routes', { waste_type: 'REL', type: 'regular', code: 'KP1', name: 'Kept plan 1', start: today, days: [1, 3, 5], stops: S(A, B) });
  const p2 = (await api('PUT', `/routes/${kp1.id}/dates/${D1}`, { rev: kp1.rev, scope: 'following', stops: S(A, B, C) })).route;
  const p3 = (await api('POST', `/routes/${p2.id}/change-schedule`, { rev: p2.rev, from: D2, days: [2, 4] })).created;

  // 1. Edit route / schedule from today: Saturday added, Friday removed. The notice updates as the chips change.
  let { dr, rf } = await openEdit('KP1', await scheduledOn('KP1', addDays(today, 1), D1));
  let t = await notes(rf, 'kept-plan');
  check(JSON.stringify(t) === JSON.stringify([`Already planned: from ${long(D2)} this route runs Tue Thu. That plan is kept.`]), 'Edit route: the later Tue Thu plan is named as kept (the part with the same weekdays is not)', t);
  await rf.getByRole('button', { name: 'Sat', exact: true }).click();
  await rf.getByRole('button', { name: 'Fri', exact: true }).click();
  t = await poll(page, async () => {
    const x = await rf.locator('[data-testid=kept-plan]').allInnerTexts();
    return x.length === 1 && /it runs/.test(x[0]) ? x : null;
  });
  await shot(page, '40-kept-plan-route-form');
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  await closeAll(dr);
  let parts = (await api('GET', `/routes/${kp1.id}`)).parts;
  let stored = parts.find((p) => p.id === p3.id);
  check(
    !!t && t[0] === `Already planned: from ${long(D2)} this route runs Tue Thu. That plan is kept; the weekdays you add or remove apply to it too, so from ${long(stored.start)} it runs ${daysText(stored.days)}.` && daysText(stored.days) === 'Tue Thu Sat',
    `Edit route from today: the notice's result is what the server stored from ${D2} (${daysText(stored.days)})`,
    { t, stored: stored.days },
  );
  check(daysText(parts.find((p) => p.id === p2.id).days) === 'Mon Wed Sat', 'the part with the same weekdays simply follows (Mon Wed Sat)', parts.map((p) => p.days));

  // 2. Apply from a date F in the first part: Friday back. The base is the part that runs on F.
  const X2 = await scheduledOn('KP1', addDays(today, 1), D1);
  const F = addDays(X2, 7) < D1 ? addDays(X2, 7) : addDays(X2, 1);
  ({ dr, rf } = await openEdit('KP1', X2));
  await rf.locator('input[type=radio]').nth(1).check();
  await rf.locator('input[aria-label="From date"]').fill(F);
  await rf.getByRole('button', { name: 'Fri', exact: true }).click();
  t = await poll(page, async () => {
    const x = await rf.locator('[data-testid=kept-plan]').allInnerTexts();
    return x.length === 1 && /Fri Sat\.$/.test(x[0]) ? x : null;
  });
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  await closeAll(dr);
  parts = (await api('GET', `/routes/${kp1.id}`)).parts;
  stored = parts.find((p) => p.id === p3.id);
  check(
    !!t && t[0] === `Already planned: from ${long(D2)} this route runs Tue Thu Sat. That plan is kept; the weekdays you add or remove apply to it too, so from ${long(stored.start)} it runs ${daysText(stored.days)}.` && daysText(stored.days) === 'Tue Thu Fri Sat',
    `Edit route from ${F}: the notice's result is what the server stored (${daysText(stored.days)})`,
    { t, stored: stored.days },
  );

  // 3. The drawer: B removed "and all following" on a date of the first part; the part from D1 keeps C.
  const kp2 = await api('POST', '/routes', { waste_type: 'REL', type: 'regular', code: 'KP2', name: 'Kept plan 2', start: today, days: [1, 3, 5], stops: S(A, B) });
  const q2 = (await api('PUT', `/routes/${kp2.id}/dates/${D1}`, { rev: kp2.rev, scope: 'following', stops: S(A, B, C) })).route;
  dr = await openDrawer('KP2', await scheduledOn('KP2', addDays(today, 1), D1));
  await dr.locator(`.stop[data-cid="${B.id}"]`).getByRole('button', { name: /^Remove from route/ }).click();
  await dr.getByRole('button', { name: 'Save', exact: true }).click();
  const sc = page.locator('.dialog', { hasText: 'Apply this change to' });
  // The notices belong to "and all following": they are not shown while "Only <date>" is selected.
  await sc.locator('input[type=radio]').nth(1).check();
  await notes(sc, 'kept-list');
  await sc.locator('input[type=radio]').nth(0).check();
  check(await poll(page, async () => (await sc.locator('[data-testid=kept-list]').count()) === 0), 'scope dialog: no kept-list notice while "Only <date>" is selected');
  await sc.locator('input[type=radio]').nth(1).check();
  t = await notes(sc, 'kept-list');
  await shot(page, '41-kept-list-scope');
  await sc.getByRole('button', { name: 'Save', exact: true }).click();
  await dr.waitFor({ state: 'detached' });
  stored = (await api('GET', `/routes/${q2.id}`)).parts.find((p) => p.id === q2.id);
  const expect3 = listNotice(stored, [A.id]);
  check(JSON.stringify(t) === JSON.stringify([expect3]) && expect3 === `Already planned from ${long(D1)}: that part keeps its own list. It also has ${C.name}.`, 'scope dialog: the later part keeps its own customer, as the server then stores', { t, expect3 });

  // 4. The template editor, opened on the part from D1: a customer added from today reaches every other part.
  await page.goto(BASE + '/routes');
  await page.locator('table tbody tr').first().waitFor();
  await page.locator('input.search').fill('KP2');
  await page.locator('table tbody tr[data-code="KP2"]').last().click();
  const te = page.locator('.drawer');
  await poll(page, async () => (await te.locator('.stoplist .stop').count()) === 2);
  await te.getByRole('button', { name: /Add customer/ }).click();
  await te.locator('.picker input[type=search]').fill(D.code);
  await te.locator('.picker-item', { hasText: D.code }).first().click();
  t = await notes(te, 'kept-list');
  await shot(page, '42-kept-list-template');
  await te.getByRole('button', { name: 'Save', exact: true }).click();
  await te.waitFor({ state: 'detached' });
  parts = (await api('GET', `/routes/${q2.id}`)).parts;
  const saved = parts.find((p) => p.id === q2.id).stops.map((s) => s.customer_id);
  const expect4 = parts.filter((p) => p.id !== q2.id).map((p) => listNotice(p, saved)).filter(Boolean);
  check(
    saved.includes(D.id) && expect4.length >= 1 && JSON.stringify([...t].sort()) === JSON.stringify([...expect4].sort()),
    `template editor: every other part's notice is what the server then stores (${expect4.length} parts)`,
    { t, expect4 },
  );
  await page.keyboard.press('Escape').catch(() => {});

  // 5. Routes page > "Change schedule from date…" on KP1's first part, from a date F2 inside the Tue Thu part:
  // the form's schedule replaces that part's own from F2, and the notice says so (nothing before a date).
  const F2 = addDays(D2, 7);
  const own3 = (await api('GET', `/routes/${kp1.id}`)).parts.find((p) => p.id === p3.id);
  await page.locator('input.search').fill('KP1');
  await page.locator('table tbody tr[data-code="KP1"]').first().locator('td.actions button').click();
  await page.getByRole('menuitem', { name: 'Change schedule from date…' }).click();
  rf = page.locator('.dialog', { hasText: 'Edit route KP1' });
  await rf.locator('form').waitFor();
  check((await rf.locator('[data-testid=kept-plan]').count()) === 0, 'Change schedule from date…: no notice before a date is picked');
  await rf.locator('input[aria-label="From date"]').fill(F2);
  await rf.getByRole('button', { name: 'Thu', exact: true }).click();
  t = await poll(page, async () => {
    const x = await rf.locator('[data-testid=kept-plan]').allInnerTexts();
    return x.length === 1 && /Thu Sat instead/.test(x[0]) ? x : null;
  });
  await shot(page, '43-kept-plan-replaced');
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  parts = (await api('GET', `/routes/${kp1.id}`)).parts;
  stored = parts.find((p) => p.start === F2);
  check(
    !!t && !!stored && t[0] === `Already planned: from ${long(D2)} this route runs ${daysText(own3.days)}. From ${long(F2)} it runs ${daysText(stored.days)} instead, as set here.` && daysText(stored.days) === 'Mon Wed Thu Sat',
    `Change schedule from ${F2}: the notice names the replaced plan and what the server stored (${stored && daysText(stored.days)})`,
    { t, stored: stored && stored.days },
  );

  // 6. The template editor on KP2's first part, from a date inside the next part (its own list): that list is
  // replaced from then, and the part after it keeps its own customers. Compared with the parts before and after.
  const before6 = (await api('GET', `/routes/${kp2.id}`)).parts;
  const [r1, r2] = before6;
  const F3 = addDays(r2.start, 2);
  // A customer the next part has too, so the saved list differs from that part's own list.
  const gone = [...r1.stops].reverse().find((s) => r2.stops.some((x) => x.customer_id === s.customer_id)) ?? r1.stops[0];
  await page.locator('input.search').fill('KP2');
  await page.locator('table tbody tr[data-code="KP2"]').first().click();
  await poll(page, async () => (await te.locator('.stoplist .stop').count()) === r1.stops.length);
  await te.locator(`.stop[data-cid="${gone.customer_id}"]`).getByRole('button', { name: /^Remove from route/ }).click();
  await te.locator('input[type=radio]').nth(1).check();
  await te.locator('input[aria-label="From date"]').fill(F3);
  const saved6 = r1.stops.filter((s) => s.customer_id !== gone.customer_id).map((s) => s.customer_id);
  const own2 = r2.stops.map((s) => s.customer_id);
  const diff6 = (() => {
    const also = own2.filter((x) => !saved6.includes(x)).map(nameOf).join(', ');
    const lacks = saved6.filter((x) => !own2.includes(x)).map(nameOf).join(', ');
    return also && lacks ? `It also has ${also} and does not have ${lacks}.` : also ? `It also has ${also}.` : `It does not have ${lacks}.`;
  })();
  t = await poll(page, async () => {
    const x = await te.locator('[data-testid=kept-list]').allInnerTexts();
    return x.some((s) => s.includes('replaces it')) ? x : null;
  });
  await shot(page, '44-kept-list-template-from');
  await te.getByRole('button', { name: 'Save', exact: true }).click();
  await te.waitFor({ state: 'detached' });
  parts = (await api('GET', `/routes/${kp2.id}`)).parts;
  const fromF3 = parts.find((p) => p.start === F3);
  const expect6 = [
    `Already planned ${when(r2)}: that part has its own list. ${diff6} From ${long(F3)} the list saved here replaces it.`,
    ...parts.filter((p) => p.start > F3).map((p) => listNotice(p, saved6)).filter(Boolean),
  ];
  check(
    !!fromF3 && JSON.stringify(fromF3.stops.map((s) => s.customer_id)) === JSON.stringify(saved6) && JSON.stringify(t) === JSON.stringify(expect6),
    `template editor from ${F3}: the replaced list and the later part's are what the server then stores`,
    { t, expect6, stored: fromF3 && fromF3.stops },
  );

  // 7. Apply from the first day of a later part with its own schedule (Tue Thu): the form's schedule replaces it,
  // and the part after it (Tue Thu Sat) gets the change measured from Tue Thu, not only the Saturday the clerk
  // ticked. Its notice names that change; it does not say that its plan is kept.
  const G1 = nextDow(addDays(today, 21), [1]);
  const G2 = addDays(G1, 15);
  const kp3 = await api('POST', '/routes', { waste_type: 'REL', type: 'regular', code: 'KP3', name: 'Kept plan 3', start: today, days: [1, 3, 5], stops: S(A, B) });
  const g1 = (await api('POST', `/routes/${kp3.id}/change-schedule`, { rev: kp3.rev, from: G1, days: [2, 4] })).created;
  const g2 = (await api('POST', `/routes/${g1.id}/change-schedule`, { rev: g1.rev, from: G2, days: [2, 4, 6] })).created;
  ({ dr, rf } = await openEdit('KP3', await scheduledOn('KP3', addDays(today, 1), G1)));
  await rf.locator('input[type=radio]').nth(1).check();
  await rf.locator('input[aria-label="From date"]').fill(G1);
  await rf.getByRole('button', { name: 'Sat', exact: true }).click();
  t = await poll(page, async () => {
    const x = await rf.locator('[data-testid=kept-plan]').allInnerTexts();
    return x.length === 2 && /Sat instead/.test(x[0]) ? x : null;
  });
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  await closeAll(dr);
  stored = (await api('GET', `/routes/${kp3.id}`)).parts.find((p) => p.id === g2.id);
  check(
    !!t &&
      t[1] === `Already planned: from ${long(G2)} this route runs Tue Thu Sat. This change, Tue Thu to Mon Wed Fri Sat from ${long(G1)}, applies to it too, so from ${long(G2)} it runs ${daysText(stored.days)}.` &&
      daysText(stored.days) === 'Mon Wed Fri Sat',
    `Apply from ${G1}, a part with its own Tue Thu: the next part's notice names the change from Tue Thu and what the server stored`,
    { t, stored: stored.days },
  );

  // 8. Another clerk changes a later part while a notice is on screen (R20 for the other parts). The save is
  // refused (STALE_REVISION), the notice is computed again on the parts loaded after that answer, and the second
  // save stores what it then says: the template editor, the scope dialog and Edit route / schedule.
  const H1 = nextDow(addDays(today, 21), [1]);
  const kp4 = await api('POST', '/routes', { waste_type: 'REL', type: 'regular', code: 'KP4', name: 'Kept plan 4', start: today, days: [1, 3, 5], stops: S(A, B) });
  const h1 = (await api('POST', `/routes/${kp4.id}/change-schedule`, { rev: kp4.rev, from: H1, days: [2, 4], stops: S(A, B, C) })).created;
  const otherClerk = async (body) => {
    const cur = await api('GET', `/routes/${h1.id}`);
    await api('POST', `/routes/${h1.id}/change-schedule`, { rev: cur.rev, from: H1, ...body });
  };
  const refused = (loc) => poll(page, async () => (await loc.locator('.form-error').allInnerTexts()).some((x) => /Someone else changed this/.test(x)));
  /** The one notice `id` in `loc`, once it reads as `ok` says. */
  const notesLike = (loc, id, ok) =>
    poll(page, async () => {
      const x = await loc.locator(`[data-testid=${id}]`).allInnerTexts();
      return x.length === 1 && ok(x[0]) ? x : null;
    });
  // 8a. the template editor (from today): the part from H1 loses B meanwhile
  await page.goto(BASE + '/routes');
  await page.locator('table tbody tr').first().waitFor();
  await page.locator('input.search').fill('KP4');
  await page.locator('table tbody tr[data-code="KP4"]').first().click();
  await poll(page, async () => (await te.locator('.stoplist .stop').count()) === 2);
  await te.getByRole('button', { name: /Add customer/ }).click();
  await te.locator('.picker input[type=search]').fill(D.code);
  await te.locator('.picker-item', { hasText: D.code }).first().click();
  const t8a = await notes(te, 'kept-list');
  await otherClerk({ stops: S(A, C) });
  await te.getByRole('button', { name: 'Save', exact: true }).click();
  const r8a = await refused(te);
  t = await notesLike(te, 'kept-list', (x) => x.includes('does not have'));
  await te.getByRole('button', { name: 'Save', exact: true }).click();
  await te.waitFor({ state: 'detached' });
  parts = (await api('GET', `/routes/${kp4.id}`)).parts;
  let saved8 = parts[0].stops.map((s) => s.customer_id);
  check(
    !!r8a && !!t && JSON.stringify(t8a) === JSON.stringify([`Already planned from ${long(H1)}: that part keeps its own list. It also has ${C.name}.`]) &&
      t[0] === listNotice(parts[1], saved8) && t[0] === `Already planned from ${long(H1)}: that part keeps its own list. It also has ${C.name} and does not have ${B.name}.`,
    'template editor: a later part changed meanwhile, the save is refused and the new notice is what the server then stores',
    { r8a, t8a, t, stored: parts[1].stops },
  );
  // 8b. the scope dialog's "and all following": the part from H1 loses D meanwhile
  dr = await openDrawer('KP4', await scheduledOn('KP4', addDays(today, 1), H1));
  await dr.locator(`.stop[data-cid="${B.id}"]`).getByRole('button', { name: /^Remove from route/ }).click();
  await dr.getByRole('button', { name: 'Save', exact: true }).click();
  await sc.locator('input[type=radio]').nth(1).check();
  const t8b = await notes(sc, 'kept-list');
  await otherClerk({ stops: S(A, C) });
  await sc.getByRole('button', { name: 'Save', exact: true }).click();
  await sc.waitFor({ state: 'detached' });
  const r8b = await refused(dr);
  await dr.getByRole('button', { name: 'Save', exact: true }).click();
  await sc.locator('input[type=radio]').nth(1).check();
  t = await notesLike(sc, 'kept-list', (x) => x.includes(`does not have ${D.name}`));
  await sc.getByRole('button', { name: 'Save', exact: true }).click();
  await dr.waitFor({ state: 'detached' });
  parts = (await api('GET', `/routes/${kp4.id}`)).parts;
  saved8 = saved8.filter((x) => x !== B.id);
  check(
    !!r8b && !!t && JSON.stringify(t8b) === JSON.stringify([`Already planned from ${long(H1)}: that part keeps its own list. It also has ${C.name}.`]) &&
      t[0] === listNotice(parts[parts.length - 1], saved8) && t[0] === `Already planned from ${long(H1)}: that part keeps its own list. It also has ${C.name} and does not have ${D.name}.`,
    'scope dialog: a later part changed meanwhile, the save is refused and the new notice is what the server then stores',
    { r8b, t8b, t, stored: parts.map((p) => p.stops) },
  );
  // 8c. Edit route / schedule from today, Saturday ticked: the part from H1 gets Friday meanwhile
  const h1Now = (await api('GET', `/routes/${kp4.id}`)).parts.find((p) => p.start === H1);
  ({ dr, rf } = await openEdit('KP4', await scheduledOn('KP4', addDays(today, 1), H1)));
  await rf.getByRole('button', { name: 'Sat', exact: true }).click();
  const t8c = await notesLike(rf, 'kept-plan', (x) => x.endsWith('it runs Tue Thu Sat.'));
  await otherClerk({ days: [2, 4, 5] });
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  const r8c = await refused(rf);
  t = await notesLike(rf, 'kept-plan', (x) => x.includes('runs Tue Thu Fri.'));
  await rf.getByRole('button', { name: 'Save', exact: true }).click();
  await rf.waitFor({ state: 'detached' });
  await closeAll(dr);
  stored = (await api('GET', `/routes/${kp4.id}`)).parts.find((p) => p.id === h1Now.id);
  check(
    !!r8c && !!t8c && !!t &&
      t[0] === `Already planned: from ${long(H1)} this route runs Tue Thu Fri. That plan is kept; the weekdays you add or remove apply to it too, so from ${long(H1)} it runs ${daysText(stored.days)}.` &&
      daysText(stored.days) === 'Tue Thu Fri Sat',
    'Edit route: a later part changed meanwhile, the save is refused and the new notice is what the server then stores',
    { r8c, t8c, t, stored: stored.days },
  );

  // 9. The template editor at 1280x800 with five later parts that have lists of their own: the notices scroll in
  // a capped area above Save, so the stop list and Save stay on screen.
  const L1 = nextDow(addDays(today, 7), [1]);
  let kp5 = await api('POST', '/routes', { waste_type: 'REL', type: 'regular', code: 'KP5', name: 'Kept plan 5', start: today, days: [1, 3, 5], stops: S(...custs.slice(0, 6)) });
  for (let k = 0, cur = kp5; k < 5; k++) {
    cur = (await api('POST', `/routes/${cur.id}/change-schedule`, { rev: cur.rev, from: addDays(L1, 7 * k), stops: S(...custs.slice(0, 4), custs[10 + 2 * k], custs[11 + 2 * k]) })).created;
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    await page.goto(BASE + '/routes');
    await page.locator('table tbody tr').first().waitFor();
    await page.locator('input.search').fill('KP5');
    await page.locator('table tbody tr[data-code="KP5"]').first().click();
    await poll(page, async () => (await te.locator('.stoplist .stop').count()) === 6);
    await te.locator('.stoplist .stop').first().getByRole('button', { name: /^Remove from route/ }).click();
    const n9 = await poll(page, async () => ((await te.locator('[data-testid=kept-list]').count()) === 5 ? 5 : 0));
    const m = await page.evaluate(() => {
      const d = document.querySelector('.drawer');
      const body = d.querySelector('.drawer-body').getBoundingClientRect();
      const rows = [...d.querySelectorAll('.stoplist .stop')].map((r) => r.getBoundingClientRect());
      const save = [...d.querySelectorAll('.drawer-foot .acts .btn')].find((b) => b.textContent === 'Save').getBoundingClientRect();
      const box = d.querySelector('.kept-notes');
      return { vh: innerHeight, saveBottom: save.bottom, rowsShown: rows.filter((r) => r.bottom <= body.bottom).length, notesH: box.clientHeight, scrolls: box.scrollHeight > box.clientHeight };
    });
    await shot(page, '45-kept-list-template-many');
    check(n9 === 5 && m.saveBottom <= m.vh && m.rowsShown >= 2 && m.notesH <= 0.3 * m.vh && m.scrolls, 'template editor at 1280x800, 5 notices: they scroll in a capped area, the list and Save stay on screen', m);
    await te.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await te.getByRole('button', { name: 'Close', exact: true }).last().click();
    await te.waitFor({ state: 'detached' });
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  // WMS_FAKE_NOW pins the server clock, so a run does not depend on the day or hour it starts (CI sets it).
  // The backend honours it only with a .demo marker in the data dir (R1); php -S gets it through env.
  if (process.env.WMS_FAKE_NOW) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '.demo'), '');
  }
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
    if (nToday > 0) {
      const n1 = todayCol.locator('.occ[data-code="N1"]');
      check(/Ali/.test(await n1.innerText()), 'today N1 shows the driver status (✓ Ali …)', await n1.innerText());
      check((await todayCol.locator('.dh .opsline').count()) === 1, "today's header shows the ops line");
    }
    const adhocRow = page.locator('.week .occ.adhoc').first();
    check((await adhocRow.count()) === 1 && /⚡A/.test(await adhocRow.innerText()), 'adhoc row has the ⚡A tag and the dashed class');
    await shot(page, '01-week');

    // 2. Highlight (click a code in a row) dims everything else; clicking again clears it. Search by customer.
    console.log('highlight and search');
    await page.locator('.week .occ[data-code="E1"] button.code').first().click();
    const e1Rows = page.locator('.week .occ[data-code="E1"]');
    const dimE1 = await e1Rows.evaluateAll((els) => els.filter((e) => e.classList.contains('dim')).length);
    const others = page.locator('.week .occ:not([data-code="E1"])');
    const dimOthers = await others.evaluateAll((els) => els.every((e) => e.classList.contains('dim')));
    check((await e1Rows.count()) > 0 && dimE1 === 0 && dimOthers, 'highlight E1: E1 rows stay, every other row dims');
    await shot(page, '02-highlight');
    await page.locator('.week .occ[data-code="E1"] button.code').first().click();
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
    // A focus refetches the calendar only once its data is stale (10 s), and the 30 s poll runs only on a range
    // with today in it (workDay can be in the next week): signal a focus until the calendar is fetched again.
    let refetched = false;
    for (let i = 0; i < 20 && !refetched; i++) {
      const got = page.waitForResponse((r) => r.url().includes('/api/calendar') && r.status() === 200, { timeout: 2000 }).then(() => true, () => false);
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      refetched = await got;
    }
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
    // (waits for the calendar refetch that follows the create)
    const adhocShown = await page.locator(`.week .day[data-date="${tomorrow}"] .occ.adhoc[data-code="${ucode}"]`).waitFor({ timeout: 10000 }).then(() => true, () => false);
    check(adhocShown, 'it shows in the week view (dashed ⚡A)');

    // 6. A Sunday: Special routes only, and nothing to plan for the other waste types.
    console.log('Sunday');
    await page.goto(`${BASE}/?view=week&anchor=${sunday}`);
    const sun = page.locator(`.week .day[data-date="${sunday}"]`);
    await sun.waitFor();
    check(!(await sun.locator('.day-foot').innerText()).includes('Regular'), 'Sunday offers no Regular');
    await sun.getByRole('button', { name: '+ Route' }).click();
    const menu = await page.locator('.menu').innerText();
    check(/Special · every Sunday/.test(menu) && /Special · this date only/.test(menu) && !/Adhoc/.test(menu), 'Sunday "+ Route" offers only Special', menu);
    await page.keyboard.press('Escape');
    check((await sun.getByRole('button', { name: '+ Task' }).count()) === 0, 'no "+ Task": OTC / COMPACTOR / EROSE are not planned');

    // 6b. Round 7: a route collects ONE waste type, picked when it is made. A Recycling route on that Sunday.
    console.log('Recycling route (one waste type per route)');
    await sun.getByRole('button', { name: '+ Route' }).click();
    await page.getByRole('menuitem', { name: /Special · this date only/ }).click();
    const rcf = page.locator('.dialog', { hasText: 'Waste type' });
    await rcf.waitFor();
    const wtSel = rcf.locator('[data-testid=route-waste-type]');
    check((await wtSel.locator('option').allInnerTexts()).join() === 'REL,Recycling' && (await wtSel.inputValue()) === 'REL', 'the route form asks for the waste type: REL (default) or Recycling; OTC / COMPACTOR / EROSE are not offered', await wtSel.locator('option').allInnerTexts());
    await wtSel.selectOption('RECYCLING');
    await rcf.locator('input.code').fill('RS1');
    await rcf.locator('label.field', { hasText: 'Name' }).locator('input').fill('Recycling Sunday');
    await rcf.getByRole('button', { name: 'Create', exact: true }).click();
    await rcf.waitFor({ state: 'detached' });
    const rcd = page.locator('.drawer', { hasText: 'Recycling Sunday' });
    await rcd.waitFor({ timeout: 10000 });
    check((await rcd.locator('.rd-title .wtag').innerText()) === 'RCY', 'the new route drawer shows the RCY tag');
    await rcd.getByRole('button', { name: /Add customer/ }).click();
    // Woodlands customers are on N1 (REL / OTC only): none is offered. Admiralty customers have Recycling.
    await rcd.locator('.picker input[type=search]').fill('Woodlands');
    await rcd.locator('.picker', { hasText: 'No customers match' }).waitFor({ timeout: 10000 }).catch(() => {});
    check((await rcd.locator('.picker-item').count()) === 0, 'the picker of a Recycling route lists no customer without Recycling');
    await rcd.locator('.picker input[type=search]').fill('Admiralty');
    await rcd.locator('.picker-item').first().waitFor();
    const offered = await rcd.locator('.picker-item').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('.wtag')].map((x) => x.textContent).join()));
    check(offered.length >= 6 && offered.every((x) => x.split(',').includes('RCY')), 'every customer it offers is registered with Recycling', offered);
    await rcd.locator('.picker-item').first().click();
    await rcd.getByRole('button', { name: 'Save', exact: true }).click();
    await rcd.waitFor({ state: 'detached' });
    const rs1 = (await occOn(sunday, 'RS1')).occ[0];
    check(rs1 && rs1.waste_type === 'RECYCLING' && rs1.type === 'special' && rs1.stops.length === 1, `Recycling route RS1 created on ${sunday} with 1 stop`, rs1 && [rs1.waste_type, rs1.stops.length]);
    await sun.locator('.occ[data-code="RS1"] .wtag').waitFor({ timeout: 10000 }).catch(() => {});
    check((await sun.locator('.occ[data-code="RS1"] .wtag').innerText()) === 'RCY' && (await sun.locator('.occ[data-code="S1"] .wtag').count()) === 0 && (await sun.locator('.occ[data-code="S1"] .tt').innerText()) === 'S', 'week rows show RCY on RS1, no waste tag on the REL route S1, and the S tag');
    // The rules behind the form (server): the type never changes, and only customers with it go on the route.
    const rs1Route = await api('GET', `/routes/${rs1.route_id}`);
    const relOnly = (await api('GET', '/customers?q=Woodlands')).find((c) => !c.waste_types.includes('RECYCLING'));
    check((await apiCode('PATCH', `/routes/${rs1.route_id}`, { rev: rs1Route.rev, waste_type: 'REL' })) === 'TYPE_IMMUTABLE', 'the waste type of a route cannot change (TYPE_IMMUTABLE)');
    check((await apiCode('PATCH', `/routes/${rs1.route_id}`, { rev: rs1Route.rev, stops: [...rs1Route.stops, { customer_id: relOnly.id, note: '' }] })) === 'CUSTOMER_NOT_ROUTABLE', 'a customer without Recycling is refused on a Recycling route (CUSTOMER_NOT_ROUTABLE)');
    check((await apiCode('POST', '/routes', { type: 'special', waste_type: 'OTC', code: 'RS2', name: 'x', date: sunday, stops: [] })) === 'TYPE_NOT_ROUTABLE', 'OTC cannot be the waste type of a route (TYPE_NOT_ROUTABLE)');
    check((await apiCode('GET', '/tasks')) === 'NOT_FOUND', 'the task API is gone (404)');
    await shot(page, '07-sunday');

    // 7. Round 7: the Submissions page (read only): what drivers submitted for the types that are not on routes.
    console.log('submissions page');
    // A third submission with a photo and a signature (as Ali, through the driver API).
    const aliTok = (await api('POST', '/login', { username: 'ali', password: 'driver-pass-2026!' })).token;
    const put = (name, type, bytes) => fetch(`${API}/api/files/${name}`, { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + aliTok }, body: Buffer.from(bytes) });
    const photo = 'e2e00000-0000-4000-8000-0000000000a1.jpg';
    const sig = 'e2e00000-0000-4000-8000-0000000000a2.png';
    await put(photo, 'image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);
    await put(sig, 'image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const erose = (await api('GET', '/customers?type=EROSE'))[0];
    const subId = 'e2e00000-0000-4000-8000-0000000000b1';
    const subBody = { op_id: 'e2e00000-0000-4000-8000-0000000000c1', base_rev: 0, waste_type: 'EROSE', customer_id: erose.id, vehicle_no: 'GBA1234X', outcome: 'collected',
      weights: { EROSE: 42.5 }, tickets: {}, photos: [photo], signature: sig, note: 'two pallets', captured_at: new Date().toISOString() };
    check((await apiCode('PUT', `/driver/submissions/${today}/${subId}`, subBody, aliTok)) === null, 'a driver submits EROSE with a photo and a signature (no task, no claim)');
    check((await apiCode('PUT', `/driver/submissions/${today}/${subId}`, subBody, aliTok)) === null, 'sending it again is a replay');
    check((await apiCode('PUT', `/driver/submissions/${today}/${subId}`, subBody)) === 'FORBIDDEN', 'the office cannot write a submission');
    await page.goto(BASE + '/submissions');
    const st = page.locator('[data-testid=subs-table]');
    await st.locator('tbody tr[data-id]').first().waitFor();
    const subRows = st.locator('tbody tr[data-id]');
    // The page lists the route records too (REL and Recycling stops of today's routes), with their route.
    const recs = await api('GET', `/submissions?date=${today}`);
    check(recs.visits.length >= 14 && (await subRows.count()) === recs.visits.length + 3, 'the page lists every route stop result of today and the 3 free submissions', [await subRows.count(), recs.visits.length]);
    const n1Row = st.locator('tr[data-source="route"]', { hasText: 'N1' }).first();
    check(/N1\s*R/.test(await n1Row.locator('td').nth(1).innerText()) && (await n1Row.locator('td').nth(2).innerText()) === 'REL' && /Ali/.test(await n1Row.innerText()) && /GBA1234X/.test(await n1Row.innerText()),
      'a regular route record shows its route (N1 R), REL, the driver and the truck', await n1Row.innerText());
    const rcyRows = st.locator('tr[data-source="route"][data-type="RECYCLING"]');
    check((await rcyRows.count()) === 2 && /R1/.test(await rcyRows.first().innerText()) && /RCY/.test(await rcyRows.first().innerText()) && /Faye/.test(await rcyRows.first().innerText()), 'the Recycling route R1 has its 2 records (RCY, Faye)', await rcyRows.count());
    await page.getByLabel('Route', { exact: true }).selectOption('route');
    check((await subRows.count()) === recs.visits.length && (await st.locator('tr[data-source="free"]').count()) === 0, 'filter "Routes only"');
    await page.getByLabel('Route', { exact: true }).selectOption('free');
    check((await subRows.count()) === 3, 'filter "No route only": the 3 free submissions of today (the resend made no second record)', await subRows.count());
    check(/3 submissions/.test(await page.locator('[data-testid=subs-count]').innerText()) && /OTC 300 kg/.test(await page.locator('[data-testid=subs-count]').innerText()), 'with the count and the totals per type', await page.locator('[data-testid=subs-count]').innerText());
    const rowText = await st.locator(`tr[data-id="${subId}"]`).innerText();
    check(/EROSE/.test(rowText) && rowText.includes(erose.name) && /42\.5 kg/.test(rowText) && /GBA1234X/.test(rowText) && /Ali/.test(rowText) && /📷1/.test(rowText) && /✍/.test(rowText), 'a row shows type, customer, weight, truck, driver, photo count and signature', rowText);
    await page.getByLabel('Type', { exact: true }).selectOption('OTC');
    check((await subRows.count()) === 1 && /ABC Restaurant/.test(await subRows.first().innerText()), 'filter by type: OTC');
    await page.getByLabel('Type', { exact: true }).selectOption('');
    await page.getByLabel('Driver', { exact: true }).selectOption('Bala');
    check((await subRows.count()) === 1 && /COMPACTOR/.test(await subRows.first().innerText()) && /1,250 kg/.test(await subRows.first().innerText()), 'filter by driver: Bala');
    await page.getByLabel('Driver', { exact: true }).selectOption('');
    await page.getByLabel('Customer', { exact: true }).fill('erose site');
    check((await subRows.count()) === 1 && (await subRows.first().getAttribute('data-id')) === subId, 'filter by customer name');
    // Details: a small document over the dimmed page, with Print and Save; only Close closes it.
    await subRows.first().getByRole('button', { name: 'Details' }).click();
    const rec = page.locator('.dialog.print-doc');
    const det = rec.locator('[data-testid=subs-details]');
    await det.locator('.thumb img').nth(1).waitFor({ timeout: 10000 }).catch(() => {});
    check((await det.locator('.thumb img').count()) === 2 && /two pallets/.test(await det.innerText()), 'Details show the photo, the signature and the note', await det.innerText());
    check((await page.locator('.scrim').count()) === 1 && (await rec.getAttribute('aria-modal')) === 'true', 'the record opens as a dialog over the dimmed page');
    const detText = await det.innerText();
    check(detText.includes(erose.name) && /42\.5 kg/.test(detText) && /GBA1234X/.test(detText) && /Ali/.test(detText) && /No route/.test(detText), 'with customer, weight, truck, driver and "No route"', detText);
    await page.keyboard.press('Escape');
    await page.locator('.scrim').click({ position: { x: 5, y: 5 } });
    check((await rec.count()) === 1 && (await rec.locator('.x-btn').count()) === 0, 'Esc and a click outside do not close it; there is no ✕');
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await rec.locator('[data-testid=subs-print]').click();
    check((await page.evaluate(() => window.__printed)) === 1, '[Print] prints the record');
    const [dl] = await Promise.all([page.waitForEvent('download'), rec.locator('[data-testid=subs-save]').click()]);
    const savedHtml = fs.readFileSync(await dl.path(), 'utf8');
    check(/^record-.*-EROSE\.html$/.test(dl.suggestedFilename()) && savedHtml.includes(erose.name) && /42\.5 kg/.test(savedHtml) && (savedHtml.match(/src="data:image\//g) || []).length === 2,
      '[Save] downloads the record as one file with the photo and the signature inside', dl.suggestedFilename());
    await rec.locator('[data-testid=subs-close]').click();
    check((await rec.count()) === 0 && (await page.locator('.scrim').count()) === 0, '[Close] closes it');
    check((await page.getByRole('button', { name: /^(Edit|Delete|New|Add)/ }).count()) === 0, 'the page is read only: no create, edit or delete');
    await page.getByLabel('Customer', { exact: true }).fill('no such customer');
    check((await subRows.count()) === 0 && /No submission matches/.test(await st.innerText()), 'no match: the empty row');
    // Another day: nothing; and the day drawer of today links here.
    await page.goto(`${BASE}/submissions?date=${addDays(today, -1)}`);
    await page.locator('text=No submissions on this day').waitFor();
    check((await subRows.count()) === 0, 'yesterday has no submissions');
    const totalsNow = (await api('GET', `/calendar?view=week&anchor=${today}`)).days.find((d) => d.date === today).totals;
    check(totalsNow.EROSE === 42.5 && totalsNow.OTC === 300, 'the calendar totals of today count the new submission (EROSE 42.5)', totalsNow);
    await shot(page, '07-submissions');

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
    console.log('route create');
    await page.goto(`${BASE}/?view=week&anchor=${workDay}`);
    const wcol = page.locator(`.week .day[data-date="${workDay}"]`);
    await wcol.locator('.occ').first().waitFor();
    await wcol.getByRole('button', { name: '+ Route' }).click();
    const items = await page.locator('.menu').innerText();
    check(/Regular · repeats weekly/.test(items) && /Adhoc · this date only/.test(items) && !/Special/.test(items), 'a work day offers Regular and ⚡ Adhoc only', items);
    await page.getByRole('menuitem', { name: 'Regular · repeats weekly' }).click();
    const rf = page.locator('.dialog', { hasText: 'New Regular route' });
    await rf.waitFor();
    await rf.locator('.chip').first().waitFor();
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
    // (the default follows the route's standing list, so it settles once the route has loaded)
    check(await poll(page, () => zsc.locator('input[type=radio]').nth(1).isChecked()), 'new route: the scope dialog pre-selects "<date> and all following"');
    await zsc.getByRole('button', { name: 'Save', exact: true }).click();
    await nd.waitFor({ state: 'detached' });
    const z9next = (await occOn(addDays(workDay, 7), 'Z9')).occ[0];
    check(z9next && z9next.stops.length === 1 && !z9next.edited, `Z9 one week later (${addDays(workDay, 7)}) has the customer too`, z9next && z9next.stops.length);
    // Round 7: a copy to another date keeps the route's waste type (R1 collects Recycling).
    const r1 = (await api('GET', '/routes')).find((r) => r.code === 'R1');
    const r1Date = (await api('GET', `/routes/${r1.id}`)).next_date;
    const copy = (await api('POST', `/routes/${r1.id}/dates/${r1Date}/copy`, { rev: r1.rev, to: sunday, code: 'R1-S' })).created;
    check(copy.waste_type === 'RECYCLING' && copy.stops.length === r1.stop_count, 'Copy to date keeps the waste type and the stops of a Recycling route', [copy.waste_type, copy.stops.length]);

    // 10. Routes page.
    console.log('routes page');
    await page.goto(BASE + '/routes');
    await page.locator('table tbody tr').first().waitFor();
    check((await page.locator('table tbody tr').count()) >= 19, 'Routes page lists the routes');
    await page.locator('table tbody tr', { hasText: 'North 2' }).first().click();
    await page.locator('.drawer .stoplist .stop').first().waitFor();
    check((await page.locator('.drawer .stoplist .stop').count()) >= 6, 'template editor shows the stop list');
    await page.keyboard.press('Escape');
    check((await page.locator('table tbody tr', { hasText: 'Recycling · North' }).first().locator('.wtag').innerText()) === 'RCY', 'Routes page: a Recycling route shows the RCY tag');
    check((await page.locator('table tbody tr', { hasText: 'North 2' }).first().locator('.wtag').innerText()) === 'REL', 'Routes page: a REL route shows the REL tag');

    // 11. Split routes (R12 / R14) in the office's forms and dialogs; the office takes a job back.
    await splitRouteChecks(page, { today, consoleErrors });
    // 12. Round 6: what a later part of a split route keeps is named before the save.
    await keptPlanChecks(page, { today });
    // 13. Round 8: a customer's own collection weekdays on a route.
    await stopDaysChecks(page, { today });

    // The browser logs every non-2xx response; the 409 RUN_EXISTS and STALE_REVISION above are expected.
    const real = consoleErrors.filter((e) => !/status of 409/.test(e));
    check(real.length === 0, 'no console errors', real.slice(0, 3));
  } catch (e) {
    await shot(page, 'zz-failure').catch(() => {}); // the screen at the moment it stopped (E2E_SHOTS, CI artifact)
    throw e;
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
