// End-to-end smoke test of the frontend shell and master-data pages (M1 + M2 demo).
// It starts its own backend (php -S) and Vite dev server, drives Chromium with Playwright, then stops both.
//
//   cd frontend && node e2e/shell.e2e.cjs
//
// Env (defaults): BACKEND_PORT=8280  FRONT_PORT=5280  WMS_DATA_DIR=/tmp/wms-test-shell
//                 E2E_SHOTS=<dir> to save screenshots   KEEP_DATA=1 to keep the data dir
//                 WMS_FAKE_NOW=<ISO 8601 time> pins the server clock; CI uses 2026-11-11T10:00:00+08:00
// Needs `playwright` resolvable by require() (preinstalled globally here) and PHP 8.3 on PATH.
// The data dir is WIPED at the start.
/* eslint-disable no-console */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONT = path.join(ROOT, 'frontend');
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8280);
const FRONT_PORT = Number(process.env.FRONT_PORT || 5280);
const DATA = process.env.WMS_DATA_DIR || '/tmp/wms-test-shell';
const SHOTS = process.env.E2E_SHOTS || '';
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}`;

const procs = [];
let failures = 0;
let passes = 0;

function check(cond, label) {
  if (cond) {
    passes++;
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label);
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
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for ' + url);
}

async function api(method, p, token, body) {
  const r = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.status === 204 ? null : r.json();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

async function main() {
  // 1. Fresh data dir, first start (prints and stores the admin password).
  fs.rmSync(DATA, { recursive: true, force: true });
  // WMS_FAKE_NOW pins the server clock, so a run does not depend on the day or hour it starts (CI sets it).
  // The backend honours it only with a .demo marker in the data dir (R1); php -S gets it through env.
  if (process.env.WMS_FAKE_NOW) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, '.demo'), '');
  }
  const env = { ...process.env, WMS_DATA_DIR: DATA };
  execFileSync('php', [path.join(ROOT, 'backend/tools/init.php')], { env, stdio: 'pipe' });
  const adminFile = path.join(DATA, 'initial-admin.txt');
  const adminPw = /password: (\S+)/.exec(fs.readFileSync(adminFile, 'utf8'))[1];
  const appDir = path.join(ROOT, 'backend/public/app');
  const builtApp = fs.existsSync(path.join(appDir, 'index.html'));
  fs.mkdirSync(appDir, { recursive: true });

  // 2. Servers.
  start('php', ['-S', `0.0.0.0:${BACKEND_PORT}`, '-t', appDir, path.join(ROOT, 'backend/public/index.php')], { cwd: ROOT, env });
  start(path.join(FRONT, 'node_modules/.bin/vite'), ['--port', String(FRONT_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: FRONT,
    env: { ...process.env, VITE_API_TARGET: API },
  });
  await waitFor(API + '/api/health');
  await waitFor(BASE + '/');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  try {
    // 3. Login as the seeded admin -> forced password change.
    console.log('login + forced password change');
    await page.goto(BASE + '/customers');
    await page.waitForURL('**/login');
    check(true, 'unauthenticated /customers redirects to /login');
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', 'wrong-password');
    await page.click('button[type=submit]');
    await page.getByRole('alert').waitFor();
    check(/用户名或密码错误|Wrong username or password/.test(await page.getByRole('alert').innerText()), 'wrong password shows BAD_CREDENTIALS text');
    await page.fill('input[name=password]', adminPw);
    await page.click('button[type=submit]');
    await page.waitForURL('**/password');
    check(true, 'first login goes to /password');
    await shot(page, '01-password');
    const NEW_PW = 'office-pass-2026';
    await page.fill('input[name=old]', adminPw);
    await page.fill('input[name=new]', NEW_PW);
    await page.fill('input[name=again]', NEW_PW);
    await page.click('button[type=submit]');
    await page.waitForURL('**/customers');
    check(true, 'after the change it returns to the page it came from (/customers)');
    check(!fs.existsSync(adminFile), 'initial-admin.txt deleted after the first password change');

    // 4. Language switch zh <-> en, stored on the user.
    console.log('language switch');
    await page.getByRole('heading', { name: '客户' }).waitFor();
    check(true, 'default language is zh (admin seed)');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('heading', { name: 'Customers' }).waitFor();
    check(true, 'switched to English');
    await page.reload();
    await page.getByRole('heading', { name: 'Customers' }).waitFor();
    check(true, 'English kept after reload (PATCH /api/me lang)');
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.getByRole('heading', { name: '客户' }).waitFor();
    check(true, 'switched back to Chinese');

    // 5. Create a customer with REL + OTC.
    console.log('customers');
    await page.getByRole('button', { name: '+ 新建客户' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: '保存' }).click();
    check(/请填写名称/.test(await dlg.locator('.form-error').innerText()), 'saving with an empty name says "请填写名称" (not a generic "输入有误")', await dlg.locator('.form-error').innerText());
    await dlg.getByLabel('名称').fill('Kopi Tiam 88');
    await dlg.getByLabel('地址').fill('Blk 312 Clementi Ave 4');
    await dlg.getByLabel('电话').fill('+65 6123 4567');
    await dlg.getByRole('button', { name: '保存' }).click();
    check(/至少选择一种垃圾类型/.test(await dlg.locator('.form-error').innerText()), 'saving without a waste type is refused in the form');
    await dlg.getByRole('button', { name: 'REL', exact: true }).click();
    await dlg.getByRole('button', { name: 'OTC', exact: true }).click();
    await dlg.getByRole('button', { name: '保存' }).click();
    await dlg.waitFor({ state: 'detached' });
    const row = page.locator('tr', { hasText: 'Kopi Tiam 88' });
    await row.waitFor();
    check((await row.locator('.wtag').allInnerTexts()).join(',') === 'REL,OTC', 'customer row shows REL and OTC tags');
    check(/^C\d{4}$/.test((await row.locator('td').first().innerText()).trim()), 'blank code generated as C + 4 digits');
    await shot(page, '02-customers');
    // Search filter
    await page.getByPlaceholder('搜索名称、编号或地址').fill('nothing-like-this');
    await page.getByText('没有符合条件的客户').waitFor();
    check(true, 'search with no match shows the empty row');
    await page.getByPlaceholder('搜索名称、编号或地址').fill('kopi');
    await row.waitFor();
    check(true, 'search finds the customer');
    // Edit: remove OTC (not in use) and add it back via API check
    await row.click();
    await page.getByRole('dialog').getByRole('button', { name: 'OTC', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    // The list refetches after the dialog closes: wait for the new tags (up to 10 s) before reading them.
    await row.locator('.wtag', { hasText: 'OTC' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    check((await row.locator('.wtag').allInnerTexts()).join(',') === 'REL', 'edit removed OTC');
    await row.click();
    await page.getByRole('dialog').getByRole('button', { name: 'OTC', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    // Archive + restore
    await row.getByRole('button', { name: '归档' }).click();
    await page.getByText('没有路线用到这个客户。').first().waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '归档' }).click();
    await page.getByText('已归档 Kopi Tiam 88').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).last().click();
    await page.locator('tr', { hasText: 'Kopi Tiam 88' }).waitFor({ state: 'detached' });
    check(true, 'archived customer leaves the active list');
    await page.getByRole('button', { name: '已归档', exact: true }).click();
    await page.locator('tr', { hasText: 'Kopi Tiam 88' }).getByRole('button', { name: '恢复' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '恢复' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '在用', exact: true }).click();
    await page.locator('tr', { hasText: 'Kopi Tiam 88' }).waitFor();
    check(true, 'restore brings it back');

    // 6. Holidays: seeded year, past locked, add one. The dates come from the server's today, so the test runs
    // on any day the holiday seed covers (2026, 2027): a new holiday on 31 Dec, and the seeded Christmas Day
    // of the same year (after 25 Dec, both in the next year).
    console.log('holidays');
    const metaTok = (await api('POST', '/api/login', null, { username: 'admin', password: NEW_PW })).data.token;
    const today = (await api('GET', '/api/meta', metaTok)).data.today;
    const Y = Number(today.slice(0, 4)) + (today.slice(5) > '12-25' ? 1 : 0);
    const NEW_HOL = `${Y}-12-31`;
    const XMAS = `${Y}-12-25`;
    const dow = new Date(NEW_HOL + 'T00:00:00Z').getUTCDay();
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    await page.getByRole('link', { name: '公共假日' }).click();
    await page.getByRole('heading', { name: '公共假日' }).waitFor();
    const christmas = page.locator('tr', { hasText: 'Christmas Day' });
    await christmas.waitFor();
    check(true, `seeded holidays of ${today.slice(0, 4)} listed`);
    check(/已过，只读/.test(await page.locator('tr', { hasText: "New Year's Day" }).innerText()), 'past holiday shows the lock');
    await page.locator('input[type=date]').fill(NEW_HOL);
    await page.getByLabel('名称', { exact: true }).fill('E2E Test Holiday');
    await page.getByRole('button', { name: '+ 添加' }).click();
    const added = page.locator('tr', { hasText: 'E2E Test Holiday' });
    await added.waitFor();
    const zhDate = `12月31日 周${'日一二三四五六'[dow]}`;
    check((await added.innerText()).includes(zhDate), `new holiday row formatted "${zhDate}"`);
    await shot(page, '03-holidays');
    await added.getByRole('button', { name: '改名' }).click();
    await page.getByRole('dialog').getByLabel('名称').fill('E2E Renamed');
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await page.locator('tr', { hasText: 'E2E Renamed' }).waitFor();
    check(true, 'holiday renamed');
    await page.locator('tr', { hasText: 'E2E Renamed' }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await page.locator('tr', { hasText: 'E2E Renamed' }).waitFor({ state: 'detached' });
    check(true, 'holiday deleted');
    await page.locator('input[type=date]').fill(NEW_HOL);
    await page.getByLabel('名称', { exact: true }).fill('E2E Test Holiday');
    await page.getByRole('button', { name: '+ 添加' }).click();
    await added.waitFor();
    // "+ 添加" on a date that already has a holiday is refused on screen (no silent rename, OFF-6).
    await page.locator('input[type=date]').fill(XMAS);
    await page.getByLabel('名称', { exact: true }).fill('Dup');
    const dupMsg = await page.locator('[data-testid=holiday-exists]').innerText();
    check((await page.getByRole('button', { name: '+ 添加' }).isDisabled()) && /已经是假日/.test(dupMsg) && dupMsg.includes('Christmas Day'), 'adding an existing holiday date is refused: "+ 添加" disabled, it names Christmas Day', dupMsg);
    await page.locator('input[type=date]').fill('');
    await page.getByLabel('名称', { exact: true }).fill('');

    // 6b. The calendar opens in the month view (Sunday first); today is blue, the new holiday red with its bar.
    console.log('calendar month view (zh)');
    await page.getByRole('link', { name: '日历' }).click();
    await page.locator('.month .mcell').first().waitFor();
    check((await page.locator('.month .mh').allInnerTexts()).join(' ') === '周日 周一 周二 周三 周四 周五 周六', 'calendar opens in the month view, 周日 first');
    check(/^\d{4}年\d{1,2}月$/.test((await page.locator('.cal-title').innerText()).trim()), 'month title "YYYY年M月"', await page.locator('.cal-title').innerText());
    const todayNum = page.locator('.month .dnum.today');
    check((await todayNum.count()) === 1 && (await todayNum.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(37, 99, 235)', "today's number has the blue circle");
    await page.goto(BASE + '/?anchor=' + NEW_HOL);
    const phCell = page.locator(`.month .mcell[data-date="${NEW_HOL}"]`);
    await phCell.locator('.mph').waitFor();
    check((await phCell.locator('.dnum').evaluate((e) => getComputedStyle(e).color)) === 'rgb(220, 38, 38)' && /★\s*E2E Test Holiday/.test(await phCell.locator('.mph').innerText()), 'the new holiday: red number and "★ E2E Test Holiday" bar');
    await page.goto(BASE + '/?view=week&anchor=' + NEW_HOL);
    await page.locator('.week .day').first().waitFor();
    const wk = await page.locator('.week .day').evaluateAll((els) => els.map((e) => e.dataset.date));
    check(wk[0] === addDays(NEW_HOL, -dow) && wk[6] === addDays(NEW_HOL, 6 - dow), 'week view runs Sunday to Saturday', wk);
    await shot(page, '03b-calendar');

    // 7. Settings: rollover (admin), trucks, waste types.
    console.log('settings');
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('heading', { name: '垃圾类型' }).waitFor();
    // The heading renders before the list query answers; wait for the rows (slow under parallel load).
    await page.locator('tbody tr').nth(2).waitFor({ timeout: 15000 }).catch(() => {});
    check((await page.locator('tbody tr').count()) >= 3, 'waste types table lists the seed types');
    await page.getByPlaceholder('例如 SBA1234X').fill('sba 1234 x');
    await page.getByRole('button', { name: '+ 添加车牌' }).click();
    await page.locator('section', { hasText: '车辆' }).getByRole('button', { name: '保存' }).click();
    await page.getByText('车辆列表已保存').waitFor();
    check(true, 'truck SBA1234X saved (normalised)');
    // Move COMPACTOR up with ↑ and save the order.
    await page.getByRole('button', { name: '上移 COMPACTOR' }).click();
    await page.getByRole('button', { name: '保存顺序' }).click();
    await page.getByText('顺序已保存').waitFor();
    check(true, 'waste type order saved');
    // Edit OTC: weighbridge
    await page.locator('tr', { hasText: 'OTC' }).getByRole('button', { name: '编辑' }).click();
    await page.getByRole('dialog').getByLabel('称重方式').selectOption('weighbridge');
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('tr', { hasText: 'OTC' }).filter({ hasText: '地磅' }).waitFor({ timeout: 10000 }).catch(() => {}); // refetch
    check(/地磅/.test(await page.locator('tr', { hasText: 'OTC' }).innerText()), 'OTC switched to weighbridge');
    await shot(page, '04-settings');

    // 8. Users: create a driver.
    console.log('users');
    await page.getByRole('link', { name: '用户' }).click();
    await page.getByRole('button', { name: '+ 新建用户' }).click();
    const udlg = page.getByRole('dialog');
    await udlg.getByLabel('用户名（3–30 位小写字母、数字、. _ -）').fill('ali');
    await udlg.getByLabel('姓名').fill('Ali');
    await udlg.locator('input.code').last().fill('driver-pass-1');
    await udlg.getByRole('button', { name: '保存' }).click();
    await udlg.waitFor({ state: 'detached' });
    const aliRow = page.locator('tr', { hasText: 'ali' }).filter({ hasText: '司机' });
    await aliRow.waitFor();
    check(/待改密码/.test(await aliRow.innerText()), 'new driver must change password');
    await shot(page, '05-users');

    // 9. API cross-check of what the UI saved.
    const tok = (await api('POST', '/api/login', null, { username: 'admin', password: NEW_PW })).data.token;
    const custs = (await api('GET', '/api/customers?q=kopi', tok)).data;
    check(custs.length === 1 && custs[0].waste_types.join(',') === 'REL,OTC', 'API: customer has REL + OTC');
    const hol = (await api('GET', `/api/holidays?year=${Y}`, tok)).data;
    check(hol.some((h) => h.date === NEW_HOL && h.name === 'E2E Test Holiday'), `API: holiday ${NEW_HOL} stored`);
    const trucks = (await api('GET', '/api/trucks', tok)).data;
    check(trucks.some((t) => t.plate === 'SBA1234X' && t.active), 'API: truck stored');
    const me = (await api('GET', '/api/me', tok)).data;
    check(me.lang === 'zh', 'API: admin language stored as zh');

    // 10. Sign out; the driver logs in, changes password, lands on /driver.
    console.log('driver');
    await page.getByRole('button', { name: /Admin/ }).click();
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
    await page.waitForURL('**/login');
    await page.fill('input[name=username]', 'ali');
    await page.fill('input[name=password]', 'driver-pass-1');
    await page.click('button[type=submit]');
    await page.waitForURL('**/password');
    await page.fill('input[name=old]', 'driver-pass-1');
    await page.fill('input[name=new]', 'driver-pass-2');
    await page.fill('input[name=again]', 'driver-pass-2');
    await page.click('button[type=submit]');
    await page.waitForURL('**/driver');
    await page.locator('.drv-top').getByText('Ali', { exact: true }).waitFor(); // the driver app's Today (top bar: driver name)
    check(true, 'driver lands on /driver (lazy chunk) after the change');
    await page.goto(BASE + '/customers');
    await page.waitForURL('**/driver');
    check(true, 'a driver opening an office page is sent to /driver');
    await shot(page, '06-driver');

    // 11. The built app served by php -S (SPA fallback), when a build exists.
    if (builtApp) {
      const p2 = await browser.newPage();
      await p2.goto(API + '/holidays');
      await p2.waitForURL('**/login');
      check(true, 'built app via php -S: /holidays falls back to index.html and routes to /login');
      await p2.close();
    } else {
      console.log('  skip built-app check (run npm run build first)');
    }

    const relevant = consoleErrors.filter((e) => !/401|Unauthorized|status of 4\d\d/.test(e));
    check(relevant.length === 0, 'no unexpected console errors' + (relevant.length ? ': ' + relevant.join(' | ') : ''));
  } catch (e) {
    failures++;
    console.log('  FAIL exception: ' + (e && e.stack ? e.stack : e));
    await shot(page, 'zz-failure').catch(() => {});
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
    for (const p of procs) console.error('--- process output ---\n' + p.output.slice(-3000));
  })
  .finally(() => {
    stopAll();
    if (!process.env.KEEP_DATA) fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
