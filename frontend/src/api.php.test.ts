// The demo build's transport (api.ts, §11.5): a fetch() call as a request to PHP's request handler
// (php-wasm), and PHP's answer as the fetch Response the API code reads.
import { describe, expect, it } from 'vitest';
import { ApiError, buildUrl, fromPhpResponse, parseEnvelope, toPhpRequest, type PhpRequest, type PhpResponse } from './api';

const enc = new TextEncoder();
const reply = (status: number, body: unknown, headers: Record<string, string[]> = {}): PhpResponse => ({
  httpStatusCode: status,
  headers: { 'content-type': ['application/json; charset=utf-8'], ...headers },
  bytes: body === undefined ? new Uint8Array() : enc.encode(JSON.stringify(body)),
});

describe('toPhpRequest', () => {
  it('keeps method, path + query, headers (with the token) and the JSON body', async () => {
    const url = buildUrl('/routes/7/dates/2026-11-20', { scope: 'following', empty: '' });
    const r = await toPhpRequest(url, {
      method: 'put',
      headers: { Accept: 'application/json', Authorization: 'Bearer t0k', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 3, stops: [{ customer_id: 12, note: '3 bins · 中文' }] }),
    });
    expect(r.method).toBe('PUT');
    expect(r.url).toBe('/api/routes/7/dates/2026-11-20?scope=following');
    expect(r.headers).toEqual({ accept: 'application/json', authorization: 'Bearer t0k', 'content-type': 'application/json' });
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ rev: 3, stops: [{ customer_id: 12, note: '3 bins · 中文' }] });
  });

  it('a GET has no body; a Blob (photo upload) is sent as its bytes', async () => {
    const get = await toPhpRequest('/api/meta', { headers: { Accept: 'application/json' } });
    expect(get.method).toBe('GET');
    expect('body' in get).toBe(false);
    const put = await toPhpRequest('/api/files/x.jpg', { method: 'PUT', body: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) });
    expect(Array.from(put.body!)).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe('fromPhpResponse', () => {
  it('status, headers and body come back as a Response the API code reads', async () => {
    const res = fromPhpResponse(reply(201, { ok: true, data: { id: 5 }, warnings: [] }, { 'x-two': ['a', 'b'] }));
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-two')).toBe('a, b');
    expect(parseEnvelope(res.status, JSON.parse(await res.text()))).toEqual({ data: { id: 5 }, warnings: [], status: 201 });
  });

  it('204 has no body', async () => {
    const res = fromPhpResponse(reply(204, undefined));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('an error envelope maps to the same ApiError as over HTTP', async () => {
    const res = fromPhpResponse(reply(409, { ok: false, error: { code: 'STALE_REVISION', message: 'm', field: null, details: { rev: 4 } } }));
    try {
      parseEnvelope(res.status, JSON.parse(await res.text()));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect([(e as ApiError).code, (e as ApiError).http, (e as ApiError).details.rev]).toEqual(['STALE_REVISION', 409, 4]);
    }
  });

  it('round trip: a handler that echoes what it got', async () => {
    const echo = async (r: PhpRequest): Promise<PhpResponse> =>
      reply(200, { ok: true, data: { method: r.method, url: r.url, auth: r.headers.authorization, body: new TextDecoder().decode(r.body) }, warnings: [] });
    const res = fromPhpResponse(await echo(await toPhpRequest('/api/me', { method: 'PATCH', headers: { Authorization: 'Bearer a' }, body: '{"lang":"en"}' })));
    expect(JSON.parse(await res.text()).data).toEqual({ method: 'PATCH', url: '/api/me', auth: 'Bearer a', body: '{"lang":"en"}' });
  });
});
