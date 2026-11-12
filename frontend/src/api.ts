// The ONLY module that knows the backend JSON (§10, §11.2): types, fetch, token storage and the
// mapping of error codes to i18n texts. Pages call the functions below and never build /api URLs.
//
// Conventions:
// - Every function returns the envelope's `data`. The few calls whose warnings or HTTP status matter
//   (EMPTY_ROUTE, OFF_PLAN, LATE, 201 vs 200) return an ApiResult {data, warnings, status} instead;
//   their names end in "Full" or they say so in the comment.
// - Failures throw ApiError {code, http, field, details}. A network failure is code NETWORK (http 0),
//   a timeout TIMEOUT (http 0).
// - Dates are 'YYYY-MM-DD' strings and timestamps ISO 8601 with +08:00, exactly as the server sends.

// ---------------------------------------------------------------------------------------------
// Basic types
// ---------------------------------------------------------------------------------------------

export type Lang = 'zh' | 'en';
export type Role = 'admin' | 'office' | 'driver';
export type IsoDate = string; // 'YYYY-MM-DD'
export type IsoTime = string; // '2026-11-11T07:40:02+08:00'

export interface Warning {
  code: string;
  message: string;
}

export interface ApiResult<T> {
  data: T;
  warnings: Warning[];
  status: number;
}

/** Every error code the server can send (§10.11) plus a few client-side ones. */
export const ERROR_CODES = [
  // Generic
  'VALIDATION', 'NOT_FOUND', 'UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL',
  // Accounts
  'BAD_CREDENTIALS', 'ACCOUNT_LOCKED', 'PASSWORD_CHANGE_REQUIRED', 'PASSWORD_TOO_SHORT', 'USERNAME_TAKEN', 'LAST_ADMIN',
  // Plan
  'TYPE_IMMUTABLE', 'WEEKDAY_NOT_ALLOWED', 'DAY_CLASS_VIOLATION', 'PAST_DATE_LOCKED', 'NOT_AN_OCCURRENCE',
  'DUPLICATE_STOP', 'CUSTOMER_INACTIVE', 'CUSTOMER_NOT_ROUTABLE', 'CODE_IN_USE', 'STALE_REVISION',
  'HOLIDAY_CONFLICT', 'RUN_EXISTS', 'TYPE_NOT_ROUTABLE',
  // Master data and settings
  'WASTE_TYPES_REQUIRED', 'UNKNOWN_WASTE_TYPE', 'WASTE_TYPE_IN_USE', 'CUSTOMER_IN_USE', 'ROLLOVER_SHIFTS_TODAY',
  // Submissions
  'TYPE_ROUTABLE', 'CUSTOMER_LACKS_TYPE',
  // Runs
  'NOT_TODAY', 'NOT_RUNNABLE', 'RUN_TAKEN', 'DRIVER_HAS_ACTIVE_RUN', 'NOT_HOLDER', 'VEHICLE_REQUIRED', 'VEHICLE_UNKNOWN',
  // Visits
  'VISIT_CHANGED', 'NOT_ON_JOB', 'TYPE_NOT_ALLOWED', 'WEIGHT_INVALID', 'WEIGHT_REQUIRED', 'TICKET_REQUIRED',
  'REASON_REQUIRED', 'WHY_REQUIRED', 'EDIT_WINDOW_CLOSED', 'FILE_MISSING',
  // Files
  'FILE_INVALID', 'FILE_TOO_LARGE',
  // Storage
  'DATA_CORRUPT', 'CLOCK_BEHIND_FREEZE',
  // Client side
  'NETWORK', 'TIMEOUT', 'UNKNOWN',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Warnings (not errors, §10.11). */
export const WARNING_CODES = ['EMPTY_ROUTE', 'OFF_PLAN', 'LATE'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export class ApiError extends Error {
  readonly code: string;
  readonly http: number;
  readonly field: string | null;
  readonly details: any;

  constructor(code: string, http: number, message = '', field: string | null = null, details: any = null) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.http = http;
    this.field = field;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

// ---------------------------------------------------------------------------------------------
// Token storage and events
// ---------------------------------------------------------------------------------------------

const TOKEN_KEY = 'wms.token';
let memoryToken: string | null = null;
/** The demo build signs in by itself at every start (src/demo): its token stays in memory only. */
const STORE_TOKEN = !__WMS_DEMO__;

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: keep the in-memory copy only */
  }
}

export function getToken(): string | null {
  if (memoryToken === null && STORE_TOKEN && typeof window !== 'undefined') memoryToken = lsGet(TOKEN_KEY);
  return memoryToken;
}
export function setToken(token: string | null): void {
  memoryToken = token;
  if (STORE_TOKEN && typeof window !== 'undefined') lsSet(TOKEN_KEY, token);
}

/** Small per-browser preferences (not secrets). */
export const prefs = {
  get: (key: string): string | null => (typeof window === 'undefined' ? null : lsGet('wms.' + key)),
  set: (key: string, value: string | null): void => {
    if (typeof window !== 'undefined') lsSet('wms.' + key, value);
  },
};

type Listener<T> = (v: T) => void;
const listeners = {
  unauthorized: new Set<Listener<ApiError>>(),
  passwordChange: new Set<Listener<ApiError>>(),
  today: new Set<Listener<IsoDate>>(),
};

/** Called on every 401 (except the login call itself). The session clears the token. */
export function onUnauthorized(fn: Listener<ApiError>): () => void {
  listeners.unauthorized.add(fn);
  return () => listeners.unauthorized.delete(fn);
}
/** Called on every 403 PASSWORD_CHANGE_REQUIRED. */
export function onPasswordChangeRequired(fn: Listener<ApiError>): () => void {
  listeners.passwordChange.add(fn);
  return () => listeners.passwordChange.delete(fn);
}
/**
 * Called with `today` whenever a successful response carries a top-level `today` (meta, calendar,
 * driver/today, …). The session compares it with its copy to detect the rollover (R36).
 */
export function onToday(fn: Listener<IsoDate>): () => void {
  listeners.today.add(fn);
  return () => listeners.today.delete(fn);
}

// ---------------------------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------------------------

export interface RequestOptions {
  /** Query parameters; undefined / null / '' values are left out. */
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** Abort after this many ms (code TIMEOUT). */
  timeoutMs?: number;
  /** Raw body (files). Sent as-is with this content type. */
  raw?: { body: Blob | ArrayBuffer; contentType: string };
  /** Do not fire the global 401 handler (login). */
  noAuthEvents?: boolean;
}

export const API_BASE = '/api';

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  let url = API_BASE + path;
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(s));
    }
    if (parts.length) url += '?' + parts.join('&');
  }
  return url;
}

// The calendar demo build (`vite build --mode demo`, §11.5) has no server: the real backend runs in this
// browser tab (php-wasm, started by src/demo/runtime.ts). Every API call then goes to PHP's request handler
// in the same shape as over HTTP (method, path + query, headers with the token, JSON body), and its answer
// comes back as a fetch Response, so everything below and the pages work unchanged. The normal build
// never contains this path (__WMS_DEMO__ is false there).

/** A request as php-wasm's PHPRequestHandler takes it. */
export interface PhpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}
/** The parts of php-wasm's PHPResponse that make the HTTP answer. */
export interface PhpResponse {
  httpStatusCode: number;
  headers: Record<string, string[]>;
  bytes: Uint8Array;
}
export type PhpHandler = (req: PhpRequest) => Promise<PhpResponse>;

let inBrowserBackend: PhpHandler | null = null;

/** Demo build: sends every API call to this handler instead of the network. */
export function setInBrowserBackend(handler: PhpHandler | null): void {
  inBrowserBackend = handler;
}

/** fetch(url, init) as a PHP request. Exported for tests. */
export async function toPhpRequest(url: string, init: RequestInit = {}): Promise<PhpRequest> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => (headers[name] = value));
  const b = init.body;
  let body: Uint8Array | undefined;
  if (typeof b === 'string') body = new TextEncoder().encode(b);
  else if (b instanceof Uint8Array) body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
  else if (b != null) throw new TypeError('Unsupported request body');
  return { method: (init.method || 'GET').toUpperCase(), url, headers, ...(body ? { body } : {}) };
}

/** A PHP answer as the fetch Response the code below reads. Exported for tests. */
export function fromPhpResponse(r: PhpResponse): Response {
  const headers = new Headers();
  for (const [name, values] of Object.entries(r.headers)) for (const v of values) headers.append(name, v);
  const noBody = r.httpStatusCode === 204 || r.httpStatusCode === 205 || r.httpStatusCode === 304;
  return new Response(noBody ? null : new Blob([r.bytes as Uint8Array<ArrayBuffer>]), { status: r.httpStatusCode, headers });
}

/** fetch() of the API: the network, or in the demo build the backend in this tab. */
function send(url: string, init: RequestInit): Promise<Response> {
  return __WMS_DEMO__ ? sendToPhp(url, init) : fetch(url, init);
}

async function sendToPhp(url: string, init: RequestInit): Promise<Response> {
  const aborted = () => new DOMException('The request was aborted', 'AbortError');
  if (!inBrowserBackend) throw new TypeError('The in-browser backend is not running');
  if (init.signal?.aborted) throw aborted();
  const res = fromPhpResponse(await inBrowserBackend(await toPhpRequest(url, init)));
  if (init.signal?.aborted) throw aborted(); // PHP cannot stop half way: the caller just gets its abort
  return res;
}

/**
 * Maps a parsed envelope (or its absence) to a result or an ApiError. Exported for tests.
 * A body that is not the API's envelope below 500 (a Wi-Fi captive portal or proxy page, often with
 * status 200) did not come from the server: it is NETWORK (http 0), so the phone's outbox keeps the result
 * and resends it, and the driver views fall back to their cached copy.
 */
export function parseEnvelope<T>(status: number, body: any): ApiResult<T> {
  if (status === 204) return { data: null as T, warnings: [], status };
  if (body && typeof body === 'object' && body.ok === true) {
    return { data: body.data as T, warnings: Array.isArray(body.warnings) ? body.warnings : [], status };
  }
  if (body && typeof body === 'object' && body.ok === false && body.error) {
    const e = body.error;
    throw new ApiError(String(e.code || 'UNKNOWN'), status, e.message || '', e.field ?? null, e.details ?? null);
  }
  if (status >= 500) throw new ApiError('INTERNAL', status, `HTTP ${status}`);
  throw new ApiError('NETWORK', 0, `HTTP ${status}: not an API response`);
}

/** Low-level request; returns the whole result. */
export async function requestFull<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload: BodyInit | undefined;
  if (opts.raw) {
    headers['Content-Type'] = opts.raw.contentType;
    payload = opts.raw.body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // The timeout covers the whole exchange, headers AND body: a body that stalls half way (a mobile link
  // dropping mid-response) ends as TIMEOUT instead of hanging the caller (and the outbox flush) for good.
  const ctrl = new AbortController();
  let timedOut = false;
  let rejectTimeout: (e: ApiError) => void = () => {};
  const timeoutP = new Promise<never>((_, reject) => (rejectTimeout = reject));
  timeoutP.catch(() => undefined);
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        rejectTimeout(new ApiError('TIMEOUT', 0, 'Request timed out'));
      }, opts.timeoutMs)
    : null;
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  let text = '';
  try {
    try {
      res = await Promise.race([send(buildUrl(path, opts.query), { method, headers, body: payload, signal: ctrl.signal, cache: 'no-store' }), timeoutP]);
      if (res.status !== 204) text = await Promise.race([res.text(), timeoutP]);
    } catch (e) {
      if (timedOut) throw new ApiError('TIMEOUT', 0, 'Request timed out');
      if (opts.signal?.aborted) throw e; // the caller cancelled: rethrow the AbortError
      throw new ApiError('NETWORK', 0, e instanceof Error ? e.message : 'Network error');
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null; // not JSON (proxy error page, …)
    }
  }

  try {
    const result = parseEnvelope<T>(res.status, json);
    const d: any = result.data;
    if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.today === 'string') {
      listeners.today.forEach((fn) => fn(d.today));
    }
    return result;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.http === 401 && !opts.noAuthEvents) listeners.unauthorized.forEach((fn) => fn(e));
      if (e.http === 403 && e.code === 'PASSWORD_CHANGE_REQUIRED') listeners.passwordChange.forEach((fn) => fn(e));
    }
    throw e;
  }
}

export async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return (await requestFull<T>(method, path, body, opts)).data;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// §10.2 Auth and me
// ---------------------------------------------------------------------------------------------

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  lang: Lang;
  must_change_password: boolean;
}

export interface LoginResult {
  token: string;
  user: User;
}

/** POST /api/login. 401 BAD_CREDENTIALS | 423 ACCOUNT_LOCKED {until}. Does not store the token. */
export function login(username: string, password: string): Promise<LoginResult> {
  return request('POST', '/login', { username, password }, { noAuthEvents: true });
}
export const getMe = (): Promise<User> => request('GET', '/me');
export const patchMe = (body: { lang: Lang }): Promise<User> => request('PATCH', '/me', body);
/** POST /api/me/password -> {token}. A wrong `old` is 422 BAD_CREDENTIALS (field "old"). */
export const changePassword = (oldPassword: string, newPassword: string): Promise<{ token: string }> =>
  request('POST', '/me/password', { old: oldPassword, new: newPassword });
export const logoutAll = (): Promise<null> => request('POST', '/me/logout-all');
export const health = (): Promise<{ ok: boolean }> => request('GET', '/health');

// ---------------------------------------------------------------------------------------------
// §10.3 Meta
// ---------------------------------------------------------------------------------------------

export type WeighMethod = 'on_site' | 'weighbridge';

export interface WasteType {
  code: string;
  name: string;
  abbr: string;
  unit: string;
  weigh_method: WeighMethod;
  routable: boolean;
  confirm_over: number | null;
  active: boolean;
}

export interface Meta {
  today: IsoDate;
  now: IsoTime;
  timezone: string;
  next_work_day: IsoDate;
  rollover_hour: number;
  day_ends_at: IsoTime;
  me: Pick<User, 'id' | 'username' | 'name' | 'role' | 'lang'>;
  waste_types: WasteType[];
  trucks: string[];
  config: { max_photos: number; driver_edit_grace_hours: number };
}

export const getMeta = (): Promise<Meta> => request('GET', '/meta');

// ---------------------------------------------------------------------------------------------
// §4.8 / §10.4 Calendar
// ---------------------------------------------------------------------------------------------

export type DayClass = 'work' | 'rest';
export type RouteType = 'regular' | 'special' | 'adhoc';
export type OccurrenceStatus = 'scheduled' | 'cancelled' | 'holiday_skipped';
export type RunStatus = 'planned' | 'not_started' | 'active' | 'open' | 'done' | 'incomplete' | 'no_record';
export type CanCreate = 'regular' | 'adhoc' | 'special' | 'special_once';
export type Outcome = 'collected' | 'missed';
export type MissReason = 'no_waste' | 'closed' | 'no_access' | 'refused' | 'other' | 'not_visited';
export const MISS_REASONS: MissReason[] = ['no_waste', 'closed', 'no_access', 'refused', 'other', 'not_visited'];
export type VisitFlag = 'OFF_PLAN' | 'LATE' | 'CONFLICT' | 'OFFICE_EDITED';
export type HoldEnd = 'finished' | 'left' | 'switched' | 'released' | 'reassigned';

export interface OpsCounts {
  not_started: number;
  active: number;
  open: number;
  done: number;
  incomplete: number;
  no_record: number;
}

export interface CalendarDay {
  date: IsoDate;
  dow: number; // 1 = Monday … 7 = Sunday
  class: DayClass;
  holiday: string | null;
  past: boolean;
  in_month: boolean;
  can_create: CanCreate[];
  totals: Record<string, number>;
  provisional: boolean;
  ops?: OpsCounts; // today and past days only
}

export interface VisitSummary {
  outcome: Outcome | null;
  weights: Record<string, number>;
  tickets: Record<string, string>;
  reason: MissReason | null;
  note: string;
  driver: string | null;
  at: IsoTime;
  rev: number;
  flags: VisitFlag[];
  photos: number;
  signature: boolean;
}

export interface RunSummary {
  driver: { id: number; name: string } | null;
  vehicle_no: string | null;
  holders: string[];
  left_by: string | null;
  /** Additive: the office took the job back (release, reassign, deactivation); left_by is then null. */
  released_by_office?: boolean;
  collected: number;
  missed: number;
  pending: number;
  total: number;
  totals: Record<string, number>;
  last_activity_at: IsoTime | null;
  flagged: number;
}

export interface OccurrenceStop {
  seq: number;
  customer_id: number;
  note: string;
  visit: VisitSummary | null;
}

export interface RouteOccurrence {
  key: string; // 'r5@2026-11-11'
  kind: 'route';
  route_id: number;
  code: string;
  color: number;
  type: RouteType;
  /** The one waste type this route collects (REL for a route stored before routes had one). */
  waste_type: string;
  name: string;
  date: IsoDate;
  recurring: boolean;
  days: number[] | null;
  sun: boolean | null;
  ph: boolean | null;
  start?: IsoDate | null;
  end?: IsoDate | null;
  /** Additive: the real period of a split route (R12 / R14); start / end are this record's. */
  route_start?: IsoDate | null;
  route_end?: IsoDate | null;
  status: OccurrenceStatus;
  edited: boolean;
  frozen: boolean;
  /** The occurrence note when set, otherwise the route note. */
  note: string;
  /** Additive server fields: the route's own note and this date's override note. */
  route_note?: string;
  occurrence_note?: string;
  /** A run whose occurrence is missing (§5.6, "plan changed"). */
  orphan?: boolean;
  rev: number;
  copied_from: { route_id: number; date: IsoDate } | null;
  covered_by: { route_id: number; code: string; date: IsoDate }[];
  stops: OccurrenceStop[];
  off_plan: { customer_id: number; visit: VisitSummary }[];
  run_status: RunStatus | null;
  run: RunSummary | null;
}

export interface CustomerRef {
  id: number;
  code: string;
  name: string;
  address: string;
  waste_types: string[];
  active: boolean;
}

export interface CalendarResponse {
  from: IsoDate;
  to: IsoDate;
  today: IsoDate;
  prev_anchor: IsoDate;
  next_anchor: IsoDate;
  missing_holiday_years: number[];
  days: CalendarDay[];
  routes: RouteOccurrence[];
  customers: Record<string, CustomerRef>;
  /** First column of the week and of the month grid (the request's week_start, default 'mon'). */
  week_start?: WeekStart;
}

export type CalendarView = 'week' | 'month';
export type WeekStart = 'mon' | 'sun';
/** week_start 'sun': Sunday-first week and month grid (the office calendar); default 'mon'. */
export const getCalendar = (view: CalendarView, anchor: IsoDate, opts?: RequestOptions, weekStart?: WeekStart): Promise<CalendarResponse> =>
  request('GET', '/calendar', undefined, { ...opts, query: { view, anchor, week_start: weekStart } });

// ---------------------------------------------------------------------------------------------
// §10.5 Routes and containers
// ---------------------------------------------------------------------------------------------

export interface Stop {
  customer_id: number;
  note: string;
}

export interface Route {
  id: number;
  code: string;
  color: number;
  type: RouteType;
  /** The one waste type the route collects; never changes. */
  waste_type: string;
  name: string;
  note: string;
  rev: number;
  recurring?: boolean;
  // recurring
  start?: IsoDate | null;
  end?: IsoDate | null;
  days?: number[] | null; // regular
  sun?: boolean | null; // special
  ph?: boolean | null; // special
  // one-off
  date?: IsoDate | null;
  copied_from?: { route_id: number; date: IsoDate } | null;
  stops: Stop[];
  /** Additive: the split route (R12 / R14) this record belongs to (its first record's id) and its real period. */
  series?: number | null;
  route_start?: IsoDate | null;
  route_end?: IsoDate | null;
}

export interface RouteOverride {
  route_id: number;
  date: IsoDate;
  cancelled: boolean;
  stops: Stop[] | null;
  note: string;
}

/** A record of a route that an edit of it reaches (§6.5): its period, schedule and template list. */
export interface RoutePart {
  id: number;
  /** The server always sends it; a part the office only predicts (routeCarry) has none of its own. */
  rev?: number;
  start: IsoDate;
  end: IsoDate | null;
  days: number[] | null; // regular
  sun: boolean | null; // special
  ph: boolean | null; // special
  stops: Stop[];
}

export interface RouteDetail extends Route {
  overrides: RouteOverride[];
  next_date?: IsoDate | null;
  /** Additive: the live parts of a split route (sorted by start, this record included); null for a one-off. */
  parts?: RoutePart[] | null;
}

export interface RouteListItem {
  id: number;
  code: string;
  color: number;
  type: RouteType;
  waste_type: string;
  name: string;
  note?: string;
  recurring?: boolean;
  days?: number[] | null;
  sun?: boolean | null;
  ph?: boolean | null;
  date?: IsoDate | null;
  start?: IsoDate | null;
  end?: IsoDate | null;
  copied_from?: { route_id: number; date: IsoDate } | null;
  stop_count: number;
  next_date: IsoDate | null;
  today_status: RunStatus | OccurrenceStatus | null;
  rev: number;
  /** Additive: the route no longer reaches today (listed only with ended=1). */
  ended?: boolean;
  /** Additive: the split route (R12 / R14) this record belongs to, its real period and its next date. */
  series?: number | null;
  route_start?: IsoDate | null;
  route_end?: IsoDate | null;
  route_next_date?: IsoDate | null;
}

export type RouteCreate = { waste_type: string } & (
  | { type: 'regular'; code: string; color?: number | null; name: string; note?: string; start: IsoDate; end?: IsoDate | null; days: number[]; stops: Stop[] }
  | { type: 'special'; code: string; color?: number | null; name: string; note?: string; start: IsoDate; end?: IsoDate | null; sun: boolean; ph: boolean; stops: Stop[] }
  | { type: 'special' | 'adhoc'; code: string; color?: number | null; name: string; note?: string; date: IsoDate; stops: Stop[] }
);

export interface RoutePatch {
  rev: number;
  code?: string;
  color?: number;
  name?: string;
  note?: string;
  days?: number[];
  sun?: boolean;
  ph?: boolean;
  start?: IsoDate;
  end?: IsoDate | null;
  date?: IsoDate;
  stops?: Stop[];
  parts?: PartRev[];
  release_run?: boolean;
}

/** Additive (§6.5): the parts (RouteDetail.parts) a screen showed before the save what an edit does to; the
 *  save is refused with 409 STALE_REVISION (field "parts") when one of them changed meanwhile. */
export interface PartRev {
  id: number;
  rev: number;
}

export interface ChangeScheduleBody {
  rev: number;
  from: IsoDate;
  days?: number[];
  sun?: boolean;
  ph?: boolean;
  end?: IsoDate | null;
  stops?: Stop[];
  parts?: PartRev[];
  release_run?: boolean;
}

export interface RouteDatePut {
  rev: number;
  scope: 'this' | 'following';
  stops?: Stop[];
  note?: string;
  cancelled?: boolean;
  parts?: PartRev[];
  release_run?: boolean;
}

export interface RouteDateResult {
  route: Route;
  occurrence: RouteOccurrence;
  ended?: Route; // when "following" split the route (R12/R14)
}

export interface CopyRouteBody {
  rev?: number;
  to: IsoDate;
  code?: string;
  name?: string;
  note?: string;
  skip_source?: boolean;
  release_run?: boolean;
}

export interface SuggestCodeResult {
  code: string;
  class: DayClass;
  holiday: string | null;
  type: RouteType;
}

export const listRoutes = (q: { ended?: boolean } = {}): Promise<RouteListItem[]> =>
  request('GET', '/routes', undefined, { query: { ended: q.ended ? 1 : 0 } });
export const getRoute = (id: number): Promise<RouteDetail> => request('GET', `/routes/${id}`);
/** 201 Route; warning EMPTY_ROUTE. */
export const createRoute = (body: RouteCreate): Promise<ApiResult<Route>> => requestFull('POST', '/routes', body);
export const patchRoute = (id: number, body: RoutePatch): Promise<ApiResult<Route>> => requestFull('PATCH', `/routes/${id}`, body);
export const changeRouteSchedule = (id: number, body: ChangeScheduleBody): Promise<ApiResult<{ ended: Route; created: Route }>> =>
  requestFull('POST', `/routes/${id}/change-schedule`, body);
export const deleteRoute = (id: number, rev: number, releaseRun = false): Promise<null> =>
  request('DELETE', `/routes/${id}`, undefined, { query: { rev, release_run: releaseRun ? 1 : undefined } });
export const putRouteDate = (id: number, date: IsoDate, body: RouteDatePut): Promise<ApiResult<RouteDateResult>> =>
  requestFull('PUT', `/routes/${id}/dates/${date}`, body);
/** Reset to route default (deletes the override). */
export const resetRouteDate = (id: number, date: IsoDate, rev: number, releaseRun = false): Promise<any> =>
  request('DELETE', `/routes/${id}/dates/${date}`, undefined, { query: { rev, release_run: releaseRun ? 1 : undefined } });
export const copyRouteDate = (id: number, date: IsoDate, body: CopyRouteBody): Promise<{ created: Route }> =>
  request('POST', `/routes/${id}/dates/${date}/copy`, body);
export const suggestRouteCode = (q: { type: 'adhoc' | 'special' | 'copy'; date: IsoDate; route_id?: number }): Promise<SuggestCodeResult> =>
  request('GET', '/routes/suggest-code', undefined, { query: q });

// ---------------------------------------------------------------------------------------------
// §10.7 Customers
// ---------------------------------------------------------------------------------------------

export interface Customer {
  id: number;
  code: string;
  name: string;
  address: string;
  phone: string;
  note: string;
  waste_types: string[];
  active: boolean;
}

export interface CustomerListItem extends Customer {
  routes: string[]; // codes of routes that use it from today on
}

export interface CustomerDetail extends Customer {
  routes: { route_id: number; code: string; name: string; type: RouteType; waste_type: string }[];
}

/** One item that a detach / archive removed (or, in CUSTOMER_IN_USE, would remove). */
export interface RemovedItem {
  kind: 'route';
  route_id: number;
  code: string;
  name?: string;
  where: 'template' | 'override' | 'one-off';
  date: IsoDate | null;
}

export interface CustomerInUseDetails {
  routes: RemovedItem[];
}

export interface CustomerWrite {
  code?: string;
  name?: string;
  address?: string;
  phone?: string;
  note?: string;
  waste_types?: string[];
}

export interface CustomerQuery {
  q?: string;
  archived?: '0' | '1' | 'all';
  routable?: boolean;
  type?: string;
}

export const listCustomers = (q: CustomerQuery = {}, opts?: RequestOptions): Promise<CustomerListItem[]> =>
  request('GET', '/customers', undefined, {
    ...opts,
    query: { q: q.q, archived: q.archived, routable: q.routable ? 1 : undefined, type: q.type },
  });
export const getCustomer = (id: number): Promise<CustomerDetail> => request('GET', `/customers/${id}`);
export const createCustomer = (body: CustomerWrite & { name: string; waste_types: string[] }): Promise<Customer> =>
  request('POST', '/customers', body);
/** PATCH; 409 CUSTOMER_IN_USE {routes} unless detach = true (then the result has `removed`). */
export const patchCustomer = (
  id: number,
  body: CustomerWrite & { detach?: boolean; release_run?: boolean },
): Promise<Customer & { removed?: RemovedItem[] }> => request('PATCH', `/customers/${id}`, body);
export const archiveCustomer = (id: number, body: { release_run?: boolean } = {}): Promise<{ removed: RemovedItem[] }> =>
  request('POST', `/customers/${id}/archive`, body);
export const restoreCustomer = (id: number): Promise<Customer> => request('POST', `/customers/${id}/restore`, {});

// ---------------------------------------------------------------------------------------------
// §10.7 Holidays
// ---------------------------------------------------------------------------------------------

export interface Holiday {
  date: IsoDate;
  name: string;
  past?: boolean; // additive server field: date < today
}

export interface HolidayConflictDetails {
  routes: { id: number; code: string; name: string; type: RouteType; date: IsoDate }[];
}

export const listHolidays = (year?: number): Promise<Holiday[]> =>
  request('GET', '/holidays', undefined, { query: { year } });
/** Upsert (201 when added, 200 when renamed). 409 HOLIDAY_CONFLICT | RUN_EXISTS, 422 PAST_DATE_LOCKED. */
export const putHoliday = (date: IsoDate, body: { name: string; release_run?: boolean }): Promise<ApiResult<Holiday>> =>
  requestFull('PUT', `/holidays/${date}`, body);
export const deleteHoliday = (date: IsoDate, releaseRun = false): Promise<null> =>
  request('DELETE', `/holidays/${date}`, undefined, { query: { release_run: releaseRun ? 1 : undefined } });

// ---------------------------------------------------------------------------------------------
// §10.7 Waste types, trucks, settings
// ---------------------------------------------------------------------------------------------

export type WasteTypeCreate = Omit<WasteType, 'active'> & { active?: boolean };
export type WasteTypePatch = Partial<Pick<WasteType, 'name' | 'abbr' | 'weigh_method' | 'confirm_over' | 'active'>>;

export interface WasteTypeInUseDetails {
  routes?: { route_id: number; code: string; name: string; type: RouteType }[];
}

export const listWasteTypes = (): Promise<WasteType[]> => request('GET', '/waste-types');
export const createWasteType = (body: WasteTypeCreate): Promise<WasteType> => request('POST', '/waste-types', body);
/** 409 WASTE_TYPE_IN_USE {routes} when a routable type that live routes collect is deactivated. */
export const patchWasteType = (code: string, body: WasteTypePatch): Promise<WasteType> =>
  request('PATCH', `/waste-types/${enc(code)}`, body);
export const orderWasteTypes = (codes: string[]): Promise<WasteType[]> => request('PUT', '/waste-types/order', { codes });

export interface Truck {
  plate: string;
  active: boolean;
}
export const listTrucks = (): Promise<Truck[]> => request('GET', '/trucks');
/** Replaces the whole list; returns the stored (normalised) list. */
export const putTrucks = (trucks: Truck[]): Promise<Truck[]> => request('PUT', '/trucks', { trucks });

export interface Settings {
  rollover_hour: number;
}
export interface RolloverShiftsDetails {
  today: IsoDate;
  would_be: IsoDate;
  retry_after: IsoTime;
}
export const getSettings = (): Promise<Settings> => request('GET', '/settings');
/** Admin. 422 VALIDATION | ROLLOVER_SHIFTS_TODAY {today, would_be, retry_after}. */
export const patchSettings = (body: Partial<Settings>): Promise<Settings> => request('PATCH', '/settings', body);

// ---------------------------------------------------------------------------------------------
// §10.7 Users and drivers
// ---------------------------------------------------------------------------------------------

export interface UserRow {
  id: number;
  username: string;
  name: string;
  role: Role;
  lang: Lang;
  active: boolean;
  must_change_password?: boolean;
  locked_until: IsoTime | null;
}

export interface UserCreate {
  username: string;
  name: string;
  role: Role;
  lang: Lang;
  password: string;
}

export interface UserPatch {
  name?: string;
  role?: Role;
  lang?: Lang;
  active?: boolean;
  /** Reset: the user must set a new password at next login; login locks are cleared. */
  password?: string;
}

export interface DriverRow {
  id: number;
  name: string;
  active: boolean;
  route_job: { date: IsoDate; job: string; code: string; pending: number } | null;
}

export const listUsers = (): Promise<UserRow[]> => request('GET', '/users');
export const createUser = (body: UserCreate): Promise<UserRow> => request('POST', '/users', body);
export const patchUser = (id: number, body: UserPatch): Promise<UserRow> => request('PATCH', `/users/${id}`, body);
export const listDrivers = (): Promise<DriverRow[]> => request('GET', '/drivers');

// ---------------------------------------------------------------------------------------------
// §10.8 Runs (office) and §10.9 Driver
// ---------------------------------------------------------------------------------------------

export interface Hold {
  driver_id: number;
  vehicle_no: string | null;
  by: string; // 'self' | 'user:<id>'
  from: IsoTime;
  to: IsoTime | null;
  end: HoldEnd | null;
}

export interface VisitValues {
  outcome: Outcome | null;
  weights: Record<string, number>;
  tickets: Record<string, string>;
  photos: string[]; // stored paths 'files/0b/<uuid>.jpg'
  signature: string | null;
  reason: MissReason | null;
  note: string;
}

export interface VisitHistoryEntry extends VisitValues {
  rev: number;
  at: IsoTime;
  by: string;
  op_id: string | null;
  why: string | null;
  rejected: boolean;
}

export interface Visit extends VisitValues {
  customer_id: number;
  why?: string | null;
  driver_id: number | null;
  by: string;
  customer: { code: string; name: string; address: string };
  captured_at: IsoTime | null;
  received_at: IsoTime;
  rev: number;
  flags: VisitFlag[];
  ops?: { op_id: string; result: string }[];
  history?: VisitHistoryEntry[];
}

export interface JobStop {
  seq: number;
  on_plan: boolean;
  stop_note: string;
  customer: { id: number; code: string; name: string; address: string; phone: string; note: string };
  weigh_types: string[];
  ticket_types: string[];
  also_on: { job: string; label: string; outcome: Outcome | null }[];
  visit: (VisitValues & { driver_id: number | null; rev: number; captured_at: IsoTime | null; flags: VisitFlag[] }) | null;
}

export interface JobDetail {
  date: IsoDate;
  job: string; // 'r5'
  kind: 'route';
  code: string;
  color: number;
  type: RouteType;
  name: string;
  note: string;
  waste_type: string; // the one type this route collects
  status: RunStatus;
  holder: { id: number; name: string } | null;
  mine: boolean;
  vehicle_no: string | null;
  progress: { collected: number; missed: number; pending: number; total: number };
  totals: Record<string, number>;
  stops: JobStop[];
}

/** GET /api/runs/{date}/{job}: JobDetail + holds + full visits with history (office). */
export interface OfficeJobDetail extends JobDetail {
  holds: Hold[];
  visits: Record<string, Visit>;
}

export interface ReleaseBody {
  mark_missed: boolean;
  reason?: MissReason;
  note?: string;
}
export type ReleaseResult = { result: 'not_started' | 'open' | 'done' };

export interface AssignBody {
  driver_id: number;
  switch?: boolean;
}
export interface AssignResult {
  run: RunSummary;
  gave_back: null | { job: string; result: 'open' | 'done' | 'not_started' };
}

/** Body of a result write (driver and office). */
export interface VisitWrite {
  op_id: string;
  base_rev: number;
  outcome: Outcome | null;
  weights?: Record<string, number | string>;
  tickets?: Record<string, string>;
  photos?: string[]; // '<uuid>.jpg' names
  signature?: string | null; // '<uuid>.png'
  reason?: MissReason | null;
  note?: string;
  captured_at?: IsoTime; // driver
  why?: string | null; // office, required when changing an existing visit
  driver_id?: number | null; // office, new visit only
  // A driver's free submission only (PUT /driver/submissions/{date}/{id}; customer_id names the customer there).
  waste_type?: string;
  customer_id?: number;
  vehicle_no?: string | null;
}

export const getRun = (date: IsoDate, job: string): Promise<OfficeJobDetail> => request('GET', `/runs/${date}/${job}`);
/** Release (mark_missed = false) or Close out (mark_missed = true). */
export const releaseRun = (date: IsoDate, job: string, body: ReleaseBody): Promise<ReleaseResult> =>
  request('POST', `/runs/${date}/${job}/release`, body);
export const assignRun = (date: IsoDate, job: string, body: AssignBody): Promise<AssignResult> =>
  request('POST', `/runs/${date}/${job}/assign`, body);
/** Office result write. 422 WHY_REQUIRED | 409 VISIT_CHANGED. */
export const putRunStop = (date: IsoDate, job: string, customerId: number, body: VisitWrite): Promise<ApiResult<{ visit: Visit; run: RunSummary }>> =>
  requestFull('PUT', `/runs/${date}/${job}/stops/${customerId}`, body);

export interface DriverRouteCard {
  job: string;
  date: IsoDate;
  code: string;
  color: number;
  type: RouteType;
  waste_type: string;
  name: string;
  note: string;
  stops: number;
  first_customers: string[];
  status: RunStatus;
  driver: { id: number; name: string } | string | null;
  left_by: string | null;
  /** Additive: the office took the job back (K5). */
  released_by_office?: boolean;
  collected: number;
  missed: number;
  pending: number;
  can_take: boolean;
}

export interface DriverToday {
  today: IsoDate;
  now: IsoTime;
  /** The rollover that ends `today` (absent in a copy cached by an older app version). */
  day_ends_at?: IsoTime;
  me: { id: number; name: string; lang: Lang };
  my_route: null | { date: IsoDate; job: string; code: string; name: string; pending: number; total: number; vehicle_no: string | null; assigned: boolean };
  waste_types: WasteType[];
  trucks: string[];
  routes: DriverRouteCard[];
}

export interface ClaimBody {
  vehicle_no: string;
  switch?: boolean;
}
export interface ClaimResult {
  run: JobDetail;
  left: null | { job: string; result: 'open' | 'done' | 'not_started' };
}
export interface DriverVisitResult {
  visit: Visit;
  progress: JobDetail['progress'];
  totals: Record<string, number>;
  replay: boolean;
}

export const driverToday = (opts?: RequestOptions): Promise<DriverToday> => request('GET', '/driver/today', undefined, opts);
export const driverJob = (date: IsoDate, job: string, opts?: RequestOptions): Promise<JobDetail> =>
  request('GET', `/driver/runs/${date}/${job}`, undefined, opts);
/** 201 created | 200 picked up / already mine. 409 RUN_TAKEN | DRIVER_HAS_ACTIVE_RUN, 422 NOT_TODAY | NOT_RUNNABLE | VEHICLE_*. */
export const claimJob = (date: IsoDate, job: string, body: ClaimBody): Promise<ApiResult<ClaimResult>> =>
  requestFull('POST', `/driver/runs/${date}/${job}/claim`, body);
/** Driver result write; warnings OFF_PLAN, LATE. Pass timeoutMs (15 s) from the outbox. */
export const putDriverStop = (date: IsoDate, job: string, customerId: number, body: VisitWrite, opts?: RequestOptions): Promise<ApiResult<DriverVisitResult>> =>
  requestFull('PUT', `/driver/runs/${date}/${job}/stops/${customerId}`, body, opts);
/** Leave / give back / finish. */
export const driverRelease = (date: IsoDate, job: string, body: ReleaseBody): Promise<ReleaseResult> =>
  request('POST', `/driver/runs/${date}/${job}/release`, body);

// ---------------------------------------------------------------------------------------------
// Free submissions of the non-routable waste types (OTC, COMPACTOR, EROSE): no plan, no claim
// ---------------------------------------------------------------------------------------------

/** A customer a driver can submit for: only its active non-routable types. */
export interface SubmitCustomer {
  id: number;
  code: string;
  name: string;
  address: string;
  waste_types: string[];
}

/** A submission: the shape of a visit plus id, date, waste_type and vehicle_no. */
export interface Submission extends Omit<Visit, 'ops' | 'history'> {
  id: string;
  date: IsoDate;
  waste_type: string;
  vehicle_no: string | null;
  ops?: Visit['ops'];
  history?: Visit['history'];
}

/** Body of PUT /driver/submissions/{date}/{id}. outcome null deletes the submission. */
export type SubmissionWrite = Omit<VisitWrite, 'why' | 'driver_id'>;

export interface DriverSubmissions {
  today: IsoDate;
  date: IsoDate;
  submissions: Submission[];
}

/** A result recorded on a route stop, as the office's records page lists it. */
export interface RouteRecord extends Visit {
  id: string; // '<job>/<customer id>'
  date: IsoDate;
  job: string;
  route: { code: string; type: RouteType; name: string };
  waste_type: string;
  vehicle_no: string | null;
  driver: string | null;
}

export interface OfficeSubmissions {
  today: IsoDate;
  date: IsoDate;
  /** Totals of the free submissions. */
  totals: Record<string, number>;
  submissions: (Submission & { driver: string | null })[];
  /** The results recorded on that day's routes (collected and not collected). */
  visits: RouteRecord[];
}

export const driverCustomers = (opts?: RequestOptions): Promise<SubmitCustomer[]> => request('GET', '/driver/customers', undefined, opts);
export const driverSubmissions = (date?: IsoDate, opts?: RequestOptions): Promise<DriverSubmissions> =>
  request('GET', '/driver/submissions', undefined, { ...opts, query: { date } });
/** 201 new | 200 changed, deleted or replayed; warning LATE. The id is made on the phone, so a resend never duplicates. */
export const putDriverSubmission = (date: IsoDate, id: string, body: SubmissionWrite, opts?: RequestOptions): Promise<ApiResult<{ submission: Submission | null; replay: boolean }>> =>
  requestFull('PUT', `/driver/submissions/${date}/${id}`, body, opts);
/** Office: what the drivers recorded on one operational day: free submissions and route stop results (read only). */
export const listSubmissions = (date: IsoDate): Promise<OfficeSubmissions> => request('GET', '/submissions', undefined, { query: { date } });

// ---------------------------------------------------------------------------------------------
// §10.10 Files
// ---------------------------------------------------------------------------------------------

export type FileExt = 'jpg' | 'png';
const FILE_NAME_RE = /^[0-9a-f-]{36}\.(jpg|png)$/;

/** 'files/0b/<uuid>.jpg' or '<uuid>.jpg' -> '<uuid>.jpg'. */
export function fileNameOf(pathOrName: string): string {
  const name = pathOrName.split('/').pop() || '';
  if (!FILE_NAME_RE.test(name)) throw new ApiError('FILE_INVALID', 0, 'Bad file name: ' + pathOrName);
  return name;
}

/** PUT /api/files/{uuid}.{ext}: 201 stored | 200 already stored (idempotent). */
export function uploadFile(uuid: string, ext: FileExt, blob: Blob, opts?: RequestOptions): Promise<ApiResult<{ path: string }>> {
  const name = fileNameOf(`${uuid}.${ext}`);
  return requestFull('PUT', `/files/${name}`, undefined, {
    ...opts,
    raw: { body: blob, contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png' },
  });
}

/** GET /api/files/{name} with the bearer token (an <img src> cannot send it, R35). */
export async function fetchFileBlob(pathOrName: string, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  const name = fileNameOf(pathOrName);
  const token = getToken();
  let res: Response;
  try {
    res = await send(buildUrl(`/files/${name}`), { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new ApiError('NETWORK', 0, 'Network error');
  }
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    parseEnvelope(res.status, body); // throws the matching ApiError
    throw new ApiError('UNKNOWN', res.status);
  }
  return res.blob();
}

/**
 * Object URL for a stored file. The caller must URL.revokeObjectURL() it when done; React code
 * should use useFileUrl() from src/ui/useFileUrl.ts, which caches the blob and revokes on unmount.
 */
export async function fileUrl(pathOrName: string): Promise<string> {
  return URL.createObjectURL(await fetchFileBlob(pathOrName));
}

// ---------------------------------------------------------------------------------------------
// Error texts (§10.11): every code maps to the i18n key `err.<CODE>`.
// ---------------------------------------------------------------------------------------------

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 'HH:MM' of an ISO timestamp, in the server's offset (+08:00): no browser time zone involved. */
export function isoTime(iso: string | null | undefined): string {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : '';
}

/** Interpolation variables for an error's message. */
export function errorVars(e: ApiError): Record<string, string | number> {
  const vars: Record<string, string | number> = { field: e.field ?? '' };
  const d = e.details;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    }
  }
  if (e.code === 'ACCOUNT_LOCKED') vars.time = isoTime(d?.until);
  if (e.code === 'ROLLOVER_SHIFTS_TODAY') vars.time = isoTime(d?.retry_after);
  if (e.code === 'RUN_TAKEN') vars.since = isoTime(d?.since);
  return vars;
}

/**
 * The user-facing text of any thrown value. VALIDATION uses the server message in English (it names
 * the exact problem) and a generic text plus the field in Chinese.
 */
export function errorText(e: unknown, t: TFunc, lang: Lang = 'zh'): string {
  if (!(e instanceof ApiError)) {
    if (e instanceof Error && e.name === 'AbortError') return t('err.NETWORK');
    return t('err.UNKNOWN');
  }
  if (e.code === 'VALIDATION') {
    if (lang === 'en' && e.message && e.message !== e.code) return e.message;
    return e.field ? t('err.VALIDATION_field', { field: e.field }) : t('err.VALIDATION');
  }
  const key = 'err.' + e.code;
  const text = t(key, errorVars(e));
  if (text !== key) return text;
  return e.message && e.message !== e.code ? e.message : t('err.UNKNOWN');
}
