#!/usr/bin/env node
// Demo data through the API, similar to the approved mockup (docs/mockup.html): ~12 regular routes a day
// (N1 … H1 on Mon–Sat patterns), three specials (Sunday / PH), an adhoc today and tomorrow, ~170 customers
// (REL, REL + OTC, Recycling, OTC only, COMPACTOR, EROSE), trucks and drivers. A route collects one waste
// type: the routes above collect REL, and two Recycling routes (R1, R2) collect RECYCLING. OTC, COMPACTOR
// and EROSE are never planned: drivers submit them freely (--with-runs makes a few submissions).
// Idempotent: existing route codes, customer codes, usernames and plates are kept.
//
//   node scripts/seed-demo.mjs [--api http://127.0.0.1:8080] [--user admin] [--password <pw>]
//                              [--new-password <pw>] [--data-dir <dir>] [--with-runs]
//
// - The admin password is --password, or WMS_PASSWORD, or read from <data-dir>/initial-admin.txt
//   (--data-dir or WMS_DATA_DIR). When the account must change its password, it is changed to
//   --new-password (default "demo-pass-2026") and the new one is printed.
// - Drivers ali, bala, chong, devi, eko get the password "driver-pass-2026" (they must change it at the
//   first sign-in unless --with-runs already did).
// - --with-runs (needs the runs/driver API, §10.8/§10.9): drivers claim some of today's routes, record a
//   few results and submit an OTC and a COMPACTOR collection, so the calendar shows live statuses and
//   totals. Skipped with a note when that API is missing.
// Routes start today (plan dates before today are locked, R11), so days before today stay empty.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);
const API = (opt('api', process.env.WMS_API || 'http://127.0.0.1:8080')).replace(/\/$/, '');
const USER = opt('user', process.env.WMS_USER || 'admin');
const DATA_DIR = opt('data-dir', process.env.WMS_DATA_DIR || '');
const NEW_PW = opt('new-password', process.env.WMS_NEW_PASSWORD || 'demo-pass-2026');
const DRIVER_PW = 'driver-pass-2026';
let PASSWORD = opt('password', process.env.WMS_PASSWORD || '');
if (!PASSWORD && DATA_DIR) {
  const f = path.join(DATA_DIR, 'initial-admin.txt');
  if (fs.existsSync(f)) PASSWORD = /password: (\S+)/.exec(fs.readFileSync(f, 'utf8'))?.[1] ?? '';
}
if (!PASSWORD) {
  console.error('No admin password: pass --password, WMS_PASSWORD or --data-dir with initial-admin.txt');
  process.exit(2);
}

let token = null;
async function call(method, p, body, tok = token) {
  const r = await fetch(API + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = r.status === 204 ? { ok: true, data: null } : await r.json().catch(() => ({ ok: false, error: { code: 'HTTP_' + r.status } }));
  return { status: r.status, ...json };
}
async function must(method, p, body, tok) {
  const r = await call(method, p, body, tok);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${r.error?.code} ${r.error?.message ?? ''}`);
  return r.data;
}
const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const weekday = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return w === 0 ? 7 : w;
};
function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

// ---- data (from the mockup) ---------------------------------------------------------------------
const MWF = [1, 3, 5];
const TTS = [2, 4, 6];
const ALL = [1, 2, 3, 4, 5, 6];
const ROUTES = [
  { code: 'N1', name: 'North 1 · Woodlands', days: ALL, color: 1, area: 'Woodlands Ave' },
  { code: 'N2', name: 'North 2 · Yishun', days: MWF, color: 2, area: 'Yishun Ring Rd' },
  { code: 'N3', name: 'Sembawang', days: TTS, color: 2, area: 'Sembawang Dr' },
  { code: 'E1', name: 'East 1 · Tampines', days: ALL, color: 3, area: 'Tampines St' },
  { code: 'E2', name: 'East 2 · Bedok', days: MWF, color: 4, area: 'Bedok North Rd' },
  { code: 'E3', name: 'Pasir Ris', days: TTS, color: 4, area: 'Pasir Ris Dr' },
  { code: 'W1', name: 'West 1 · Jurong West', days: ALL, color: 5, area: 'Jurong West St' },
  { code: 'W2', name: 'West 2 · Clementi', days: MWF, color: 6, area: 'Clementi Ave' },
  { code: 'W3', name: 'Tuas Industrial', days: ALL, color: 7, area: 'Tuas South Ave' },
  { code: 'C1', name: 'Central 1 · Toa Payoh', days: ALL, color: 8, area: 'Toa Payoh Lor' },
  { code: 'C2', name: 'Central 2 · Bukit Merah', days: TTS, color: 9, area: 'Bukit Merah View' },
  { code: 'C3', name: 'Chinatown', days: ALL, color: 10, area: 'Smith St' },
  { code: 'K1', name: 'Kallang', days: MWF, color: 1, area: 'Kallang Bahru' },
  { code: 'K2', name: 'Serangoon', days: TTS, color: 1, area: 'Serangoon Ave' },
  { code: 'T1', name: 'Tampines Industrial', days: ALL, color: 3, area: 'Tampines Industrial Ave' },
  { code: 'H1', name: 'Hospitals & clinics', days: ALL, color: 9, area: 'Outram Rd' },
  { code: 'S1', name: 'Sunday market', sun: true, ph: true, color: 5, area: 'Geylang Serai' },
  { code: 'S2', name: 'Holiday food & beverage', sun: true, ph: true, color: 7, area: 'Orchard Rd' },
  { code: 'S3', name: 'PH hospital run', sun: false, ph: true, color: 10, area: 'Jalan Bukit Merah' },
  // Recycling routes (kept last, so the customer codes of the routes above never change).
  { code: 'R1', name: 'Recycling · North', days: MWF, color: 6, area: 'Admiralty Dr', waste: 'RECYCLING' },
  { code: 'R2', name: 'Recycling · East', days: TTS, color: 6, area: 'Changi Rd', waste: 'RECYCLING' },
];
const POOL = [
  'ABC Restaurant', 'Kopi Tiam 88', 'FairPrice Supermarket', 'Hawker 21 Food Court', 'Golden Bakery', 'Lucky Seafood',
  'Prime Logistics', 'Sunrise Clinic', 'Tan Hardware', 'Ocean Hotel', 'Jade 茶楼', 'Metro Office Tower', 'Green School Canteen',
  'Lim Printing', 'City Gym', 'Orchid Florist', 'Harbour Cold Store', 'Star Motor Works', 'Happy Childcare', 'Royal Banquet Hall',
  'Seng Provision', 'Bright Factory', 'Unity Community Centre', 'Pearl Condo', 'Fortune 酒楼', 'Ace Electronics', 'Nanyang Food Factory',
  'Bayview Mall', 'Hill Primary School', 'Peony Restaurant', 'Kim Coffee Shop', 'Delta Frozen Foods',
];

async function main() {
  // 1. Sign in (and change the first-start password).
  let r = await call('POST', '/login', { username: USER, password: PASSWORD });
  if (!r.ok) throw new Error('login failed: ' + r.error?.code);
  token = r.data.token;
  if (r.data.user.must_change_password) {
    token = (await must('POST', '/me/password', { old: PASSWORD, new: NEW_PW })).token;
    console.log(`admin password changed to: ${NEW_PW}`);
  }
  const meta = await must('GET', '/meta');
  const today = meta.today;
  console.log(`today (op_date) = ${today}, next work day = ${meta.next_work_day}`);

  // 1b. The seed waste types of a new data folder; an older folder gets the two new ones here (the demo
  // tool only: a live data folder is never changed by itself).
  for (const w of [
    { code: 'RECYCLING', name: 'Recycling', abbr: 'RCY', routable: true, confirm_over: 1000 },
    { code: 'EROSE', name: 'EROSE', abbr: 'EROSE', routable: false, confirm_over: null },
  ]) {
    if (!meta.waste_types.some((x) => x.code === w.code)) await must('POST', '/waste-types', { ...w, unit: 'kg', weigh_method: 'on_site' });
  }

  // 2. Trucks and drivers.
  const trucks = await must('GET', '/trucks');
  const plates = new Set(trucks.map((x) => x.plate));
  const want = ['SBA1234X', 'GBA1234X', 'SGX9021K', 'SBB5678Z'];
  if (want.some((p) => !plates.has(p))) {
    await must('PUT', '/trucks', { trucks: [...trucks, ...want.filter((p) => !plates.has(p)).map((plate) => ({ plate, active: true }))] });
  }
  const users = await must('GET', '/users');
  const drivers = [
    ['ali', 'Ali'], ['bala', 'Bala'], ['chong', 'Chong'], ['devi', 'Devi'], ['eko', 'Eko'],
  ];
  for (const [username, name] of drivers) {
    if (!users.some((u) => u.username === username)) {
      await must('POST', '/users', { username, name, role: 'driver', lang: 'en', password: DRIVER_PW });
    }
  }
  if (!users.some((u) => u.username === 'mei')) {
    await must('POST', '/users', { username: 'mei', name: 'Mei', role: 'office', lang: 'zh', password: 'office-pass-2026' });
  }

  // 3. Customers (codes C1xxx are the demo set).
  const existing = await must('GET', '/customers?archived=all');
  const byCode = new Map(existing.map((c) => [c.code, c]));
  async function customer(code, name, address, types, phone = '') {
    if (byCode.has(code)) return byCode.get(code);
    const c = await must('POST', '/customers', { code, name, address, phone, note: '', waste_types: types });
    byCode.set(code, c);
    return c;
  }
  const routeStops = {};
  let seq = 1000;
  for (const [ri, rt] of ROUTES.entries()) {
    const n = 6 + (hash(rt.code) % 5);
    routeStops[rt.code] = [];
    for (let k = 0; k < n; k++) {
      const base = POOL[(ri * 7 + k * 3) % POOL.length];
      const short = rt.area.split(' ')[0];
      // a route's customers are registered with the route's waste type
      const types = rt.waste === 'RECYCLING' ? (k % 3 === 0 ? ['REL', 'RECYCLING'] : ['RECYCLING']) : k % 4 === 0 ? ['REL', 'OTC'] : ['REL'];
      const c = await customer(`C${++seq}`, `${base} · ${short}`, `Blk ${100 + (hash(rt.code + k) % 800)} ${rt.area} ${1 + (k % 9)}`, types, k % 3 === 0 ? `+65 9${(hash(rt.code + 'p' + k) % 9000000) + 1000000}` : '');
      routeStops[rt.code].push({ customer_id: c.id, note: k === 0 ? '3 bins' : '' });
    }
  }
  // Non-routable customers (never offered in the route picker).
  const compactors = [];
  for (let k = 0; k < 6; k++) {
    compactors.push(await customer(`C${2001 + k}`, `${['Tuas', 'Jurong', 'Changi', 'Senoko', 'Loyang', 'Kaki Bukit'][k]} Compactor Site`, `${10 + k} Industrial Rd`, ['COMPACTOR']));
  }
  const otcOnly = [];
  for (let k = 0; k < 6; k++) {
    otcOnly.push(await customer(`C${2101 + k}`, `${['Renovation', 'Office Move', 'Condo MCST', 'Event Hall', 'Warehouse Clear', 'Shophouse'][k]} ${k + 1}`, `${20 + k} Jalan Besar`, ['OTC']));
  }
  for (let k = 0; k < 3; k++) {
    await customer(`C${2201 + k}`, `${['Harbour', 'Airport', 'Science Park'][k]} EROSE Site`, `${30 + k} Pioneer Rd`, ['EROSE']);
  }
  // ABC Restaurant (REL + OTC) also goes on the adhoc routes: "also on N1".
  const abc = byCode.get('C1001');
  const kopi = byCode.get('C1002');

  // 4. Routes (start today; adhoc A2 today and A1 on the next work day).
  const routes = await must('GET', '/routes?ended=1');
  const haveCode = (code, date) => routes.some((x) => x.code === code && (!x.date || x.date === date));
  let created = 0;
  for (const rt of ROUTES) {
    if (haveCode(rt.code)) continue;
    const waste_type = rt.waste ?? 'REL';
    const body = rt.days
      ? { waste_type, type: 'regular', code: rt.code, color: rt.color, name: rt.name, note: '', start: today, end: null, days: rt.days, stops: routeStops[rt.code] }
      : { waste_type, type: 'special', code: rt.code, color: rt.color, name: rt.name, note: '', start: today, end: null, sun: rt.sun, ph: rt.ph, stops: routeStops[rt.code] };
    await must('POST', '/routes', body);
    created++;
  }
  const adhoc = async (date, code, name, note, stops) => {
    const sug = await must('GET', `/routes/suggest-code?type=adhoc&date=${date}`);
    if (sug.class !== 'work' || routes.some((x) => x.date === date && x.name === name)) return;
    await must('POST', '/routes', { type: 'adhoc', waste_type: 'REL', code: haveCode(code, date) ? sug.code : code, name, note, date, stops });
    created++;
  };
  await adhoc(today, 'A2', 'Construction site clean-up', 'Call this morning: today please', [{ customer_id: byCode.get('C1050').id, note: 'gate B' }]);
  await adhoc(meta.next_work_day, 'A1', 'ABC Restaurant overflow', 'Customer called: add 2 places tomorrow', [
    { customer_id: abc.id, note: '' },
    { customer_id: kopi.id, note: '' },
  ]);

  console.log(`seeded: ${created} new routes, ${byCode.size} customers in total, trucks ok, drivers ok`);

  // 6. Optional live statuses (runs API, §10.9).
  if (flag('with-runs')) await simulateRuns(today, { otc: abc, compactor: compactors[0] });
}

async function simulateRuns(today, cust) {
  const tokens = {};
  for (const u of ['ali', 'bala', 'chong', 'devi']) {
    let r = await call('POST', '/login', { username: u, password: DRIVER_PW });
    if (!r.ok) r = await call('POST', '/login', { username: u, password: DRIVER_PW + '!' });
    if (!r.ok) {
      console.log(`runs: cannot sign in as ${u} (${r.error?.code}); skipped`);
      return;
    }
    let tok = r.data.token;
    if (r.data.user.must_change_password) tok = (await must('POST', '/me/password', { old: DRIVER_PW, new: DRIVER_PW + '!' }, tok)).token;
    tokens[u] = tok;
  }
  const day = await call('GET', '/driver/today', undefined, tokens.ali);
  if (!day.ok) {
    console.log(`runs: the driver API is not available (${day.status} ${day.error?.code}); live statuses skipped`);
    return;
  }
  const plan = [
    ['ali', 'N1', 'GBA1234X', 99],
    ['bala', 'E1', 'SBA1234X', 3],
    ['chong', 'W1', 'SGX9021K', 1],
    ['devi', 'C1', 'SBB5678Z', 0],
  ];
  for (const [u, code, plate, n] of plan) {
    const card = day.data.routes.find((x) => x.code === code);
    if (!card) continue;
    const c = await call('POST', `/driver/runs/${today}/${card.job}/claim`, { vehicle_no: plate }, tokens[u]);
    if (!c.ok) {
      console.log(`runs: ${u} claim ${code}: ${c.error?.code}`);
      continue;
    }
    const job = c.data.run;
    for (const s of job.stops.slice(0, n)) {
      await call('PUT', `/driver/runs/${today}/${card.job}/stops/${s.customer.id}`, {
        op_id: crypto.randomUUID(), base_rev: 0, outcome: 'collected',
        weights: Object.fromEntries(s.weigh_types.map((w) => [w, 20 + (hash(code + s.customer.id) % 180)])),
        tickets: {}, photos: [], signature: null, reason: null, note: '', captured_at: new Date().toISOString(),
      }, tokens[u]);
    }
    console.log(`runs: ${u} took ${code} and recorded ${Math.min(n, job.stops.length)} stops`);
  }
  // Free submissions (no plan, no claim): Ali submits an OTC collection, Bala a COMPACTOR one. The ids are
  // fixed, so running the seed again changes nothing (a resend never makes a second record).
  const submit = async (u, id, waste_type, customer, plate, kg) => {
    const r = await call('PUT', `/driver/submissions/${today}/${id}`, {
      op_id: crypto.randomUUID(), base_rev: 0, waste_type, customer_id: customer.id, vehicle_no: plate, outcome: 'collected',
      weights: { [waste_type]: kg }, tickets: {}, photos: [], signature: null, note: '', captured_at: new Date().toISOString(),
    }, tokens[u]);
    console.log(`runs: ${u} submitted ${waste_type} ${kg} kg for ${customer.name}: ${r.ok ? 'ok' : r.error?.code}`);
  };
  await submit('ali', '0a11ce00-0000-4000-8000-000000000001', 'OTC', cust.otc, 'GBA1234X', 300);
  await submit('bala', '0a11ce00-0000-4000-8000-000000000002', 'COMPACTOR', cust.compactor, 'SBA1234X', 1250);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
