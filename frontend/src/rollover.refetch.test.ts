// §13 rollover refetch: a poll response (or the day_ends_at timer) with a new `today` triggers a
// /api/meta refetch, a reload of the driver's Today list and the invalidation of every query, including a
// calendar range that does not contain today. Runs the real api.ts + watchRollover / armRolloverTimer
// wiring used by the session, with a fake server behind global fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import * as api from './api';
import { armRolloverTimer, watchRollover } from './rollover';
import { rangeContainsToday } from './office/calendarModel';

let serverToday = '2026-11-11';
const hits: Record<string, number> = {};

function envelope(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data, warnings: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeServer(url: string): Response {
  const u = new URL(url, 'http://test');
  const key = u.pathname + (u.searchParams.get('anchor') ? '@' + u.searchParams.get('anchor') : '');
  hits[key] = (hits[key] ?? 0) + 1;
  if (u.pathname === '/api/meta') {
    return envelope({ today: serverToday, now: `${serverToday}T23:59:00+08:00`, day_ends_at: '2026-11-12T04:00:00+08:00' });
  }
  if (u.pathname === '/api/calendar') {
    const anchor = u.searchParams.get('anchor')!;
    const from = anchor === '2026-11-16' ? '2026-11-16' : '2026-11-09';
    const to = anchor === '2026-11-16' ? '2026-11-22' : '2026-11-15';
    return envelope({ from, to, today: serverToday, days: [], routes: [], tasks: [], customers: {} });
  }
  if (u.pathname === '/api/driver/today') return envelope({ today: serverToday, routes: [], tasks: [] });
  return new Response('{}', { status: 404 });
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const observe = (queryKey: unknown[], queryFn: () => Promise<unknown>) => {
    const obs = new QueryObserver(qc, { queryKey, queryFn });
    return obs.subscribe(() => {});
  };
  const offs = [
    observe(['meta'], api.getMeta),
    observe(['calendar', 'week', '2026-11-09'], () => api.getCalendar('week', '2026-11-09')),
    observe(['calendar', 'week', '2026-11-16'], () => api.getCalendar('week', '2026-11-16')),
    observe(['driver', 'today'], () => api.driverToday()),
  ];
  return { qc, stop: () => offs.forEach((f) => f()) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  serverToday = '2026-11-11';
  for (const k of Object.keys(hits)) delete hits[k];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => fakeServer(url)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('rollover refetch (R36)', () => {
  it('a poll with a new today refetches meta, the Today list and every calendar range', async () => {
    const { qc, stop } = setup();
    const known = { current: '2026-11-11' as string | undefined };
    const off = watchRollover(qc, known);
    await settle();
    expect(hits['/api/meta']).toBe(1);
    expect(hits['/api/calendar@2026-11-16']).toBe(1);
    expect(rangeContainsToday(qc.getQueryData(['calendar', 'week', '2026-11-16']))).toBe(false);

    // Same day: a poll changes nothing else.
    await qc.refetchQueries({ queryKey: ['calendar', 'week', '2026-11-09'] });
    await settle();
    expect(hits['/api/meta']).toBe(1);

    // The rollover passed: the next 30 s poll of this week carries today = Thu.
    serverToday = '2026-11-12';
    await qc.refetchQueries({ queryKey: ['calendar', 'week', '2026-11-09'] });
    await settle();
    expect(known.current).toBe('2026-11-12');
    expect(hits['/api/meta']).toBe(2); // meta refetched -> new day_ends_at re-arms the timer
    expect(hits['/api/driver/today']).toBe(2); // the driver's Today reloads
    expect(hits['/api/calendar@2026-11-16']).toBe(2); // a range without today refetches too
    expect((qc.getQueryData(['meta']) as api.Meta).today).toBe('2026-11-12');
    // The decision whether to poll uses the new today.
    expect(rangeContainsToday(qc.getQueryData(['calendar', 'week', '2026-11-09']))).toBe(true);

    // Exactly once: further responses with the same new today do not invalidate again.
    await settle();
    expect(hits['/api/meta']).toBe(2);
    off();
    stop();
  });

  it('the day_ends_at timer invalidates every query at the rollover', async () => {
    const { qc, stop } = setup();
    await settle();
    vi.useFakeTimers();
    const cancel = armRolloverTimer(qc, { now: '2026-11-12T03:59:00+08:00', day_ends_at: '2026-11-12T04:00:00+08:00' }, 0, 0);
    serverToday = '2026-11-12';
    await vi.advanceTimersByTimeAsync(61_000); // 60 s + less than the 2 s margin: not yet
    expect(hits['/api/meta']).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await settle();
    expect(hits['/api/meta']).toBe(2);
    expect(hits['/api/calendar@2026-11-16']).toBe(2);
    expect(hits['/api/driver/today']).toBe(2);
    cancel();
    stop();
  });
});
