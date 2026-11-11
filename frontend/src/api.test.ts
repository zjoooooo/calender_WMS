// api.ts mappers (§13): envelope parsing, URL building, error texts, auth / today events, files.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  buildUrl,
  errorText,
  fileNameOf,
  getMeta,
  listCustomers,
  login,
  onToday,
  onUnauthorized,
  parseEnvelope,
  deleteRoute,
  requestFull,
  setToken,
} from './api';
import { translate } from './i18n';

const tZh = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
const tEn = (k: string, v?: Record<string, string | number>) => translate('en', k, v);

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('parseEnvelope', () => {
  it('returns data and warnings of a success envelope', () => {
    const r = parseEnvelope<{ id: number }>(201, { ok: true, data: { id: 5 }, warnings: [{ code: 'EMPTY_ROUTE', message: 'x' }] });
    expect(r).toEqual({ data: { id: 5 }, warnings: [{ code: 'EMPTY_ROUTE', message: 'x' }], status: 201 });
  });

  it('204 has no data', () => {
    expect(parseEnvelope(204, null)).toEqual({ data: null, warnings: [], status: 204 });
  });

  it('throws ApiError with code, field and details', () => {
    try {
      parseEnvelope(423, { ok: false, error: { code: 'ACCOUNT_LOCKED', message: 'm', field: null, details: { until: '2026-11-11T07:52:00+08:00' } } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const a = e as ApiError;
      expect([a.code, a.http, a.details.until]).toEqual(['ACCOUNT_LOCKED', 423, '2026-11-11T07:52:00+08:00']);
    }
  });

  it('a non-envelope page below 500 (captive portal, proxy) is NETWORK, not a server answer', () => {
    for (const status of [200, 302, 404]) {
      try {
        parseEnvelope(status, null);
        expect.unreachable();
      } catch (e) {
        expect([(e as ApiError).code, (e as ApiError).http]).toEqual(['NETWORK', 0]);
      }
    }
  });

  it('a non-JSON 502 is INTERNAL', () => {
    expect(() => parseEnvelope(502, null)).toThrowError(ApiError);
    try {
      parseEnvelope(502, null);
    } catch (e) {
      expect((e as ApiError).code).toBe('INTERNAL');
    }
  });
});

describe('buildUrl', () => {
  it('drops empty values and encodes booleans as 1/0', () => {
    expect(buildUrl('/customers', { q: 'a b', archived: '0', routable: true, type: undefined, x: '' })).toBe('/api/customers?q=a%20b&archived=0&routable=1');
    expect(buildUrl('/meta')).toBe('/api/meta');
  });
});

describe('errorText', () => {
  it('maps codes to texts with variables from details', () => {
    const locked = new ApiError('ACCOUNT_LOCKED', 423, '', null, { until: '2026-11-11T07:52:00+08:00' });
    expect(errorText(locked, tEn, 'en')).toBe('Too many wrong passwords. Try again at 07:52');
    expect(errorText(locked, tZh, 'zh')).toBe('密码错误次数太多，请在 07:52 后再试');
    const roll = new ApiError('ROLLOVER_SHIFTS_TODAY', 422, '', 'rollover_hour', { retry_after: '2026-11-12T04:00:00+08:00' });
    expect(errorText(roll, tEn, 'en')).toBe('This change would move today. Try again after 04:00');
  });

  it('VALIDATION: server message in English, generic + field in Chinese', () => {
    const v = new ApiError('VALIDATION', 422, 'Customer code C1 is already used', 'code');
    expect(errorText(v, tEn, 'en')).toBe('Customer code C1 is already used');
    expect(errorText(v, tZh, 'zh')).toBe('输入有误：code');
  });

  it('unknown codes fall back to the server message, other errors to UNKNOWN', () => {
    expect(errorText(new ApiError('SOMETHING_NEW', 422, 'Server says no'), tEn, 'en')).toBe('Server says no');
    expect(errorText(new Error('x'), tEn, 'en')).toBe('Something went wrong');
  });
});

describe('requestFull via the endpoint functions', () => {
  it('sends the bearer token and unwraps data; reports `today`', async () => {
    setToken('tok123');
    const fetchFn = mockFetch(200, { ok: true, data: { today: '2026-11-11', rollover_hour: 4 }, warnings: [] });
    const seen: string[] = [];
    const off = onToday((d) => seen.push(d));
    const meta = await getMeta();
    off();
    expect(meta.today).toBe('2026-11-11');
    expect(seen).toEqual(['2026-11-11']);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/meta');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
  });

  it('builds query strings for list endpoints and DELETE with rev', async () => {
    const fetchFn = mockFetch(200, { ok: true, data: [], warnings: [] });
    await listCustomers({ q: 'kopi', archived: 'all', routable: true });
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('/api/customers?q=kopi&archived=all&routable=1');
    mockFetch(204, undefined);
    await expect(deleteRoute(5, 4, true)).resolves.toBeNull();
  });

  it('401 fires the unauthorized event, except for login', async () => {
    mockFetch(401, { ok: false, error: { code: 'UNAUTHORIZED', message: '', field: null, details: null } });
    const hits: string[] = [];
    const off = onUnauthorized((e) => hits.push(e.code));
    await expect(getMeta()).rejects.toMatchObject({ code: 'UNAUTHORIZED', http: 401 });
    mockFetch(401, { ok: false, error: { code: 'BAD_CREDENTIALS', message: '', field: null, details: null } });
    await expect(login('a', 'b')).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    off();
    expect(hits).toEqual(['UNAUTHORIZED']);
  });

  it('the timeout also covers a response body that stalls (TIMEOUT, not a hang)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stalled = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"ok":true,"da'));
          },
        });
        return new Response(stalled, { status: 200 });
      }),
    );
    const t0 = Date.now();
    await expect(requestFull('GET', '/meta', undefined, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT', http: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('an HTML page with status 200 is NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await expect(getMeta()).rejects.toMatchObject({ code: 'NETWORK', http: 0 });
  });

  it('a network failure is NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(getMeta()).rejects.toMatchObject({ code: 'NETWORK', http: 0 });
  });
});

describe('files', () => {
  it('fileNameOf accepts stored paths and names, refuses traversal', () => {
    const name = '0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg';
    expect(fileNameOf('files/0b/' + name)).toBe(name);
    expect(fileNameOf(name)).toBe(name);
    expect(() => fileNameOf('../secret.key')).toThrow(ApiError);
  });
});
