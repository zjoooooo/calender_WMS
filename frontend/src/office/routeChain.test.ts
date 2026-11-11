// Split routes (K2, K3, SPLIT-UI-05/08/12): the client groups route records the way Plan::chain does.
import { describe, expect, it } from 'vitest';
import { chainPeriod, endTarget, liveChain, routeChain, segmentOn, segmentPeriods, type Segment } from './routeChain';

const seg = (id: number, code: string, start: string, end: string | null, extra: Partial<Segment> = {}): Segment => ({
  id,
  code,
  type: 'regular',
  rev: 1,
  recurring: true,
  start,
  end,
  days: [1, 3, 5],
  ...extra,
});

// E2 split at Fri 20 Nov and again at Wed 25 Nov; an unrelated K1; a one-off E2 on another date.
const routes: Segment[] = [
  seg(22, 'E2', '2026-11-20', '2026-11-24'),
  seg(5, 'E2', '2026-11-11', '2026-11-19'),
  seg(30, 'E2', '2026-11-25', null),
  seg(13, 'K1', '2026-11-11', null),
  { id: 40, code: 'E2', type: 'adhoc', rev: 1, recurring: false, date: '2026-12-26' },
  // the same code and type, but not contiguous (a gap): a different route period
  seg(50, 'W1', '2026-11-01', '2026-11-05'),
  seg(51, 'W1', '2026-11-11', null),
];

describe('routeChain', () => {
  it('finds every segment of a split route from any of them, sorted by start', () => {
    for (const id of [5, 22, 30]) expect(routeChain(routes, id).map((r) => r.id)).toEqual([5, 22, 30]);
  });
  it('a route that was never split, a one-off, or a gap is its own chain', () => {
    expect(routeChain(routes, 13).map((r) => r.id)).toEqual([13]);
    expect(routeChain(routes, 40).map((r) => r.id)).toEqual([40]);
    expect(routeChain(routes, 51).map((r) => r.id)).toEqual([51]);
    expect(routeChain(routes, 999)).toEqual([]);
  });
  it('codes match without case; another type never chains', () => {
    const rs = [seg(1, 'n1', '2026-11-11', '2026-11-19'), seg(2, 'N1', '2026-11-20', null), seg(3, 'N1', '2026-11-11', null, { type: 'special' })];
    expect(routeChain(rs, 2).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('liveChain (what an edit or a delete reaches)', () => {
  it('today 11 Nov: all three parts', () => {
    expect(liveChain(routes, 30, '2026-11-11').map((r) => r.id)).toEqual([5, 22, 30]);
  });
  it('today 21 Nov: the part that ended on 19 Nov is left alone', () => {
    expect(liveChain(routes, 22, '2026-11-21').map((r) => r.id)).toEqual([22, 30]);
  });
  it('an ended part reaches only itself', () => {
    expect(liveChain(routes, 5, '2026-11-21').map((r) => r.id)).toEqual([5]);
  });
});

describe('chain period and targets', () => {
  const chain = routeChain(routes, 22);
  it("the route's real start and end (K3, SPLIT-UI-05)", () => {
    expect(chainPeriod(chain)).toEqual({ start: '2026-11-11', end: null });
    expect(chainPeriod(routeChain(routes, 50))).toEqual({ start: '2026-11-01', end: '2026-11-05' });
  });
  it('segmentOn: the part that runs on a date', () => {
    expect(segmentOn(chain, '2026-11-11')?.id).toBe(5);
    expect(segmentOn(chain, '2026-11-19')?.id).toBe(5);
    expect(segmentOn(chain, '2026-11-20')?.id).toBe(22);
    expect(segmentOn(chain, '2026-12-31')?.id).toBe(30);
    expect(segmentOn(chain, '2026-11-01')?.id).toBe(5);
  });
  it('endTarget: "end from D" goes to the part that runs on D (SPLIT-UI-12)', () => {
    expect(endTarget(chain, '2026-11-16')?.id).toBe(5); // end 15 Nov: inside the first part
    expect(endTarget(chain, '2026-11-25')?.id).toBe(30); // from the first day of the last part
    expect(endTarget(chain, '2026-12-01')?.id).toBe(30);
  });
  it('segmentPeriods names every part', () => {
    const fmt = (d: string) => d.slice(8);
    expect(segmentPeriods(chain, fmt, (d) => `from ${d}`)).toEqual(['11 – 19', '20 – 24', 'from 25']);
  });
});

describe('with the server series and real period (additive fields)', () => {
  // R1 ended 30 Nov; a NEW route R1 from 1 Dec reuses the code: contiguous, but its own series.
  const rs: Segment[] = [
    seg(1, 'R1', '2026-11-11', '2026-11-30', { series: 1, route_start: '2026-11-11', route_end: '2026-11-30' }),
    seg(2, 'R1', '2026-12-01', null, { series: 2, route_start: '2026-12-01', route_end: null }),
    seg(3, 'E2', '2026-11-11', '2026-11-19', { series: 3, route_start: '2026-11-11', route_end: null }),
    seg(4, 'E2', '2026-11-20', null, { series: 3, route_start: '2026-11-11', route_end: null }),
  ];
  it('groups by series, not by code and dates', () => {
    expect(routeChain(rs, 2).map((r) => r.id)).toEqual([2]);
    expect(routeChain(rs, 1).map((r) => r.id)).toEqual([1]);
    expect(routeChain(rs, 4).map((r) => r.id)).toEqual([3, 4]);
  });
  it("uses the server's route_start / route_end", () => {
    expect(chainPeriod(routeChain(rs, 4))).toEqual({ start: '2026-11-11', end: null });
  });
});
