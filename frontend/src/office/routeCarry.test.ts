// Round 6 (§6.5): the office predicts what an edit of a split route does to its other parts, before the save.
// The shared cases (backend/tests/fixtures/split_carry_cases.json: T2, E2, C2, T5, T6 of plan_split_chain_test.php
// and more) are also run against the server there, so the mirror equals what the server stores.
import { describe, expect, it } from 'vitest';
import type { RoutePart, Stop } from '../api';
import { translate } from '../i18n';
import shared from '../../../backend/tests/fixtures/split_carry_cases.json';
import {
  afterFollowing,
  afterPatch,
  afterSplit,
  carryDays,
  carrySunPh,
  dayEffects,
  daysReset,
  fitStops,
  keptListsFollowing,
  keptListsTemplate,
  keptListText,
  keptSchedules,
  keptScheduleText,
  mergeStops,
  partsRev,
  standingFromDay,
} from './routeCarry';

interface Case {
  name: string;
  type: 'regular' | 'special';
  parts: RoutePart[];
  call: { kind: 'patch' | 'schedule' | 'following'; id: number; date?: string; body: Record<string, unknown> };
  after: RoutePart[];
}
const { cases, today } = shared as unknown as { cases: Case[]; today: string };

const S = (...ids: number[]): Stop[] => ids.map((customer_id) => ({ customer_id, note: '' }));
const R = (id: number, start: string, end: string | null, days: number[], stops: Stop[]): RoutePart => ({ id, start, end, days, sun: null, ph: null, stops });
const ids = (l: Stop[]) => l.map((s) => s.customer_id);
const en = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const zh = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
const NAMES: Record<number, string> = { 12: 'ABC Restaurant', 21: 'Sunday Market Stall', 40: 'Golden Bakery', 70: 'Zed Ended Route' };
const nameOf = (id: number) => NAMES[id] ?? `#${id}`;

describe('the shared carry cases (what the server stores)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const b = c.call.body;
      if (c.call.kind === 'patch') expect(afterPatch(c.parts, c.call.id, b)).toEqual(c.after);
      else if (c.call.kind === 'schedule') expect(afterSplit(c.parts, b as { from: string }, today)).toEqual(c.after);
      // "following": record id has the list from the date on; the later parts are predicted
      else expect(afterFollowing(c.parts, c.call.id, b.stops as Stop[], c.call.date!)).toEqual(c.after.filter((p) => p.start > c.call.date!));
    });
  }
  it('covers the scenarios of plan_split_chain_test.php', () => {
    for (const s of ['T2', 'E2', 'C2', 'T5', 'T6']) expect(cases.some((c) => c.name.startsWith(s)), s).toBe(true);
  });
});

describe('Plan::carry rules', () => {
  it('weekdays: added join, removed leave, none left takes the new ones', () => {
    expect(carryDays([2, 4], [1, 3, 5], [1, 3])).toEqual([2, 4]);
    expect(carryDays([2, 4], [1, 3, 5], [1, 3, 5, 6])).toEqual([2, 4, 6]);
    expect(carryDays([4], [2, 4], [2])).toEqual([2]);
    expect(carryDays([2, 4], [1, 3], [1, 3])).toEqual([2, 4]);
  });
  it('Sunday / PH: a changed flag takes its new value; neither left takes the new choice', () => {
    expect(carrySunPh({ sun: true, ph: false }, { sun: true, ph: true }, { sun: false, ph: true })).toEqual({ sun: false, ph: true });
    expect(carrySunPh({ sun: false, ph: true }, { sun: true, ph: true }, { sun: true, ph: false })).toEqual({ sun: true, ph: false });
    expect(carrySunPh({ sun: true, ph: false }, { sun: true, ph: true }, { sun: true, ph: true })).toEqual({ sun: true, ph: false });
  });
  it('lists: equal to the starting list becomes the new one; otherwise only the change', () => {
    expect(mergeStops(S(12, 40), S(40, 12), S(12, 40))).toEqual(S(40, 12));
    expect(mergeStops(S(12, 40), S(12, 70, 40), S(21, 40, 12))).toEqual(S(21, 70, 40, 12));
    expect(mergeStops(S(12, 40, 21), S(21, 40, 12, 70), S(12, 40))).toEqual(S(40, 12, 70));
    expect(mergeStops(S(12, 40), S(40), S(70, 12, 21, 40))).toEqual(S(70, 21, 40));
  });
  it('a refused schedule change predicts nothing', () => {
    const parts = [R(1, '2026-11-11', '2026-11-30', [1, 3, 5], S(12)), R(2, '2026-12-01', '2026-12-31', [2], S(12))];
    expect(afterSplit(parts, { from: today, days: [1] }, today)).toBeNull();
    expect(afterSplit(parts, { from: '2026-11-11', days: [1] }, today)).toBeNull();
    expect(afterSplit(parts, { from: '2027-01-04', days: [1] }, today)).toBeNull();
    expect(afterSplit(parts, { from: '2026-12-07', days: [1], end: '2026-12-01' }, today)).toBeNull();
  });
  it('a schedule the server refuses (no weekday, neither Sunday nor PH) predicts nothing', () => {
    const parts = [R(1, '2026-11-11', '2026-11-30', [1, 3, 5], S(12)), R(2, '2026-12-01', null, [1, 3], S(12))];
    expect(afterPatch(parts, 1, { days: [] })).toBeNull();
    expect(afterSplit(parts, { from: '2026-11-20', days: [] }, today)).toBeNull();
    expect(keptSchedules(parts, afterPatch(parts, 1, { days: [] }), 1, null)).toEqual([]);
    const sp: RoutePart[] = [{ id: 3, start: '2026-11-15', end: null, days: null, sun: true, ph: false, stops: S(21) }];
    expect(afterPatch(sp, 3, { sun: false })).toBeNull();
    expect(afterPatch(sp, 3, { sun: false, ph: true })).toEqual([{ ...sp[0], sun: false, ph: true }]);
  });
});

// T2: Mon/Wed/Fri now (opened), Mon/Wed/Fri from 2 Dec (its own list), Tue/Thu from 21 Dec.
const T2 = [R(101, '2026-11-11', '2026-12-01', [1, 3, 5], S(12, 40)), R(102, '2026-12-02', '2026-12-20', [1, 3, 5], S(40, 12)), R(103, '2026-12-21', null, [2, 4], S(40, 12))];

describe('Edit route / schedule: the notice names what a later part keeps', () => {
  it('T2: Mon/Wed from 25 Nov keeps Tue/Thu from 21 Dec, and says only that', () => {
    const k = keptSchedules(T2, afterSplit(T2, { from: '2026-11-25', days: [1, 3] }, today), 101, '2026-11-25');
    expect(k.map((x) => x.part.id)).toEqual([103]);
    expect(k[0].after.days).toEqual([2, 4]);
    expect(keptScheduleText(k[0], today, en, 'en')).toBe('Already planned: from Mon 21 Dec this route runs Tue Thu. That plan is kept.');
    expect(keptScheduleText(k[0], today, zh, 'zh')).toBe('已有安排：12月21日起这条路线是 周二、周四。这个安排会保留。');
  });
  it('from today, Saturday added: the later part gets it too, and the notice gives the result', () => {
    const k = keptSchedules(T2, afterPatch(T2, 101, { days: [1, 3, 5, 6] }), 101, null);
    expect(k.map((x) => [x.part.id, x.after.days])).toEqual([[103, [2, 4, 6]]]);
    expect(keptScheduleText(k[0], today, en, 'en')).toBe(
      'Already planned: from Mon 21 Dec this route runs Tue Thu. That plan is kept; the weekdays you add or remove apply to it too, so from Mon 21 Dec it runs Tue Thu Sat.',
    );
    expect(keptScheduleText(k[0], today, zh, 'zh')).toBe(
      '已有安排：12月21日起这条路线是 周二、周四。这个安排会保留；你加上或去掉的星期也会同样改到它上面，所以12月21日起是 周二、周四、周六。',
    );
  });
  it('opened on the later part, a change from today also reaches the part that runs now', () => {
    const k = keptSchedules(T2, afterPatch(T2, 103, { days: [2, 4, 6] }), 103, null);
    expect(k.map((x) => [x.part.id, x.after.days])).toEqual([
      [101, [1, 3, 5, 6]],
      [102, [1, 3, 5, 6]],
    ]);
    expect(keptScheduleText(k[0], today, en, 'en')).toMatch(/^Already planned: until Tue 1 Dec this route runs Mon Wed Fri\. .* so until Tue 1 Dec it runs Mon Wed Fri Sat\.$/);
  });
  it('from a date inside a later part with its own schedule: that schedule is replaced from then', () => {
    const k = keptSchedules(T2, afterSplit(T2, { from: '2026-12-28', days: [1, 3, 5] }, today), 101, '2026-12-28');
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ part: { id: 103 }, after: { id: 0, start: '2026-12-28', days: [1, 3, 5] }, replacedFrom: '2026-12-28' });
    expect(keptScheduleText(k[0], today, en, 'en')).toBe('Already planned: from Mon 21 Dec this route runs Tue Thu. From Mon 28 Dec it runs Mon Wed Fri instead, as set here.');
    // ticking that part's own days replaces nothing
    expect(keptSchedules(T2, afterSplit(T2, { from: '2026-12-28', days: [2, 4] }, today), 101, '2026-12-28')).toEqual([]);
  });
  it('from the first day of a part with its own schedule: the part after it gets the change measured from the replaced one, and is told so', () => {
    // the shared case "from the first day of a later part with its own schedule" (the server stores the same)
    const parts = [R(211, '2026-11-11', '2026-12-06', [1, 3, 5], S(12, 40)), R(212, '2026-12-07', '2026-12-21', [2, 4], S(12, 40)), R(213, '2026-12-22', null, [2, 4, 6], S(12, 40))];
    const k = keptSchedules(parts, afterSplit(parts, { from: '2026-12-07', days: [1, 3, 5, 6] }, today), 211, '2026-12-07');
    expect(k.map((x) => [x.part.id, x.after.days, x.replacedFrom ?? null, x.via ? [x.via.old.days, x.via.neu.days] : null])).toEqual([
      [212, [1, 3, 5, 6], '2026-12-07', null],
      [213, [1, 3, 5, 6], null, [[2, 4], [1, 3, 5, 6]]],
    ]);
    // Tue and Thu leave the 22 Dec part although the clerk did not untick them: it does not say "kept" or "you add or remove"
    expect(keptScheduleText(k[1], today, en, 'en')).toBe(
      'Already planned: from Tue 22 Dec this route runs Tue Thu Sat. This change, Tue Thu to Mon Wed Fri Sat from Mon 7 Dec, applies to it too, so from Tue 22 Dec it runs Mon Wed Fri Sat.',
    );
    expect(keptScheduleText(k[1], today, zh, 'zh')).toBe(
      '已有安排：12月22日起这条路线是 周二、周四、周六。这次的修改（从12月7日起由 周二、周四 改为 周一、周三、周五、周六）也会同样改到它上面，所以12月22日起是 周一、周三、周五、周六。',
    );
    // a later part the change does not reach is only said to be kept
    const k2 = keptSchedules(parts, afterSplit(parts, { from: '2026-12-07', days: [2, 4, 6] }, today), 211, '2026-12-07');
    expect(k2.map((x) => keptScheduleText(x, today, en, 'en'))).toEqual([
      'Already planned: from Mon 7 Dec to Mon 21 Dec this route runs Tue Thu. From Mon 7 Dec it runs Tue Thu Sat instead, as set here.',
      'Already planned: from Tue 22 Dec this route runs Tue Thu Sat. That plan is kept.',
    ]);
  });
  it('from a date inside a later part with the same schedule (split only by its list): nothing is said about it', () => {
    const k = keptSchedules(T2, afterSplit(T2, { from: '2026-12-09', days: [1, 3] }, today), 101, '2026-12-09');
    expect(k.map((x) => [x.part.id, x.after.days, x.replacedFrom ?? null])).toEqual([[103, [2, 4], null]]);
  });
  it('a later part with the same schedule just follows; a part the new end removes is not named', () => {
    expect(keptSchedules(T2, afterPatch(T2, 101, { days: [1, 3], end: '2026-12-15' }), 101, null)).toEqual([]);
    const k = keptSchedules(T2, afterPatch(T2, 101, { days: [1, 3], end: '2027-01-31' }), 101, null);
    expect(k.map((x) => [x.part.id, x.after.end])).toEqual([[103, '2027-01-31']]);
    expect(keptScheduleText(k[0], today, en, 'en')).toBe('Already planned: from Mon 21 Dec this route runs Tue Thu. That plan is kept.');
  });
  it('special: the Sunday / PH change and the result', () => {
    const sp = (id: number, start: string, end: string | null, sun: boolean, ph: boolean): RoutePart => ({ id, start, end, days: null, sun, ph, stops: S(21) });
    const parts = [sp(171, '2026-11-15', '2026-12-05', true, true), sp(172, '2026-12-06', null, false, true)];
    const k = keptSchedules(parts, afterPatch(parts, 171, { ph: false }), 171, null);
    expect(keptScheduleText(k[0], today, en, 'en')).toBe(
      'Already planned: from Sun 6 Dec this route runs every PH. That plan is kept; your change to Sunday / PH applies to it too, so from Sun 6 Dec it runs every Sunday.',
    );
  });
});

// T5: the 2 Dec part has its own customer 21; the drawer saves "this date and following".
const T5 = [R(131, '2026-11-11', '2026-12-01', [1, 3, 5], S(12, 40)), R(132, '2026-12-02', '2026-12-20', [1, 3, 5], S(12, 40, 21)), R(133, '2026-12-21', null, [2, 4], S(12, 40, 21))];

describe('the save sends the parts its notices were computed on', () => {
  it('ids and revs as the server gave them; nothing when a part has no rev (an older server)', () => {
    const parts = [{ ...T2[0], rev: 4 }, { ...T2[1], rev: 2 }, { ...T2[2], rev: 1 }];
    expect(partsRev(parts)).toEqual([
      { id: 101, rev: 4 },
      { id: 102, rev: 2 },
      { id: 103, rev: 1 },
    ]);
    expect(partsRev(T2)).toBeUndefined();
    expect(partsRev(null)).toBeUndefined();
    expect(partsRev([])).toBeUndefined();
  });
});

describe('stop lists: the notice names what a later part also has or does not have', () => {
  it('T5: list [70] from 25 Nov: 2 Dec = [21, 70]; named per part', () => {
    const k = keptListsFollowing(T5, 131, S(70), '2026-11-25');
    expect(k.map((x) => [x.part.id, ids(x.after.stops), x.also, x.lacks])).toEqual([
      [132, [21, 70], [21], []],
      [133, [21, 70], [21], []],
    ]);
    expect(keptListText(k[0], today, en, 'en', nameOf)).toBe('Already planned from Wed 2 Dec to Sun 20 Dec: that part keeps its own list. It also has Sunday Market Stall.');
    expect(keptListText(k[1], today, zh, 'zh', nameOf)).toBe('已有安排（12月21日起）：那一段保留自己的名单。它比这份名单多了 Sunday Market Stall。');
  });
  it('also has and does not have; a pure order difference is not named', () => {
    const parts = [R(1, '2026-11-11', '2026-12-01', [1, 3, 5], S(12, 40, 21)), R(2, '2026-12-02', null, [1, 3, 5], S(21, 40, 12))];
    expect(afterFollowing(parts, 1, S(12, 40), '2026-11-25').map((p) => ids(p.stops))).toEqual([[40, 12]]);
    expect(keptListsFollowing(parts, 1, S(12, 40), '2026-11-25')).toEqual([]);
    const own = [R(1, '2026-11-11', '2026-12-01', [1, 3, 5], S(12, 40)), R(2, '2026-12-02', null, [1, 3, 5], S(21, 40))];
    const k = keptListsFollowing(own, 1, S(12, 40, 70), '2026-11-25');
    expect(k.map((x) => [x.also, x.lacks])).toEqual([[[21], [12]]]);
    expect(keptListText(k[0], today, en, 'en', nameOf)).toBe('Already planned from Wed 2 Dec: that part keeps its own list. It also has Sunday Market Stall and does not have ABC Restaurant.');
    expect(keptListText(k[0], today, zh, 'zh', nameOf)).toBe('已有安排（12月2日起）：那一段保留自己的名单。它比这份名单多了 Sunday Market Stall，少了 ABC Restaurant。');
  });
  it('the template editor from today reaches every other part, the one that runs now too', () => {
    const k = keptListsTemplate(T5, 132, S(12, 21, 70), null, today);
    expect(k.map((x) => [x.part.id, ids(x.after.stops), x.also, x.lacks])).toEqual([[131, [12, 70], [], [21]]]);
    expect(keptListText(k[0], today, en, 'en', nameOf)).toBe('Already planned until Tue 1 Dec: that part keeps its own list. It does not have Sunday Market Stall.');
  });
  it('the template editor from D inside another part: that part\'s own list is replaced from D', () => {
    const k = keptListsTemplate(T5, 131, S(12, 40, 70), '2026-12-07', today);
    // 133 had the same list as 132, so it simply takes the saved list
    expect(k.map((x) => [x.part.id, x.replacedFrom ?? null, x.also, x.lacks])).toEqual([[132, '2026-12-07', [21], [70]]]);
    expect(keptListText(k[0], today, en, 'en', nameOf)).toBe(
      'Already planned from Wed 2 Dec to Sun 20 Dec: that part has its own list. It also has Sunday Market Stall and does not have Zed Ended Route. From Mon 7 Dec the list saved here replaces it.',
    );
    expect(keptListsTemplate(T5, 131, S(12, 40), '2026-11-11', today)).toEqual([]); // refused (today)
  });
  it('the template editor from D inside a later part with the same customers: nothing is said about it', () => {
    const parts = [R(1, '2026-11-11', '2026-12-01', [1, 3, 5], S(12, 40)), R(2, '2026-12-02', null, [2, 4], S(40, 12))];
    expect(keptListsTemplate(parts, 1, S(12, 40, 70), '2026-12-08', today)).toEqual([]);
  });
});

// Round 8: a stop's own collection weekdays.
const D = (customer_id: number, days?: number[]): Stop => ({ customer_id, note: '', ...(days ? { days } : {}) });

describe('stop weekdays', () => {
  it('fitStops: kept inside the days; a stop left with none has no weekdays', () => {
    expect(fitStops([D(12, [1, 5]), D(40, [5]), D(21)], [1, 3])).toEqual([D(12, [1]), D(40), D(21)]);
    expect('days' in fitStops([D(40, [5])], [1, 3])[0]).toBe(false);
  });
  it('mergeStops: new weekdays follow only where the stop still has the old ones', () => {
    expect(mergeStops([D(12), D(40)], [D(12), D(40, [1, 3])], [D(40), D(21), D(12)])).toEqual([D(40, [1, 3]), D(21), D(12)]);
    expect(mergeStops([D(12, [1]), D(40)], [D(12, [1, 3]), D(40)], [D(40), D(12, [2])])).toEqual([D(40), D(12, [2])]);
    expect(mergeStops([D(12, [1]), D(40)], [D(12), D(40)], [D(40), D(12, [1])])).toEqual([D(40), D(12)]);
  });
  // backend stop_days_test case 8: Wed 18 Nov, the date's list is 40, 21
  const part = R(1, '2026-11-11', null, [1, 3, 5], [D(12, [1]), D(40), D(21, [3, 5])]);
  const wed = '2026-11-18';
  it('standingFromDay: the saves of "this date and following"', () => {
    expect(standingFromDay(part, wed, S(21, 40, 70))).toEqual([D(12, [1]), D(21, [3, 5]), D(40), D(70)]);
    expect(standingFromDay(part, wed, S(40))).toEqual([D(12, [1]), D(40), D(21, [5])]);
    expect(standingFromDay(part, wed, S(21))).toEqual([D(12, [1]), D(21, [3, 5])]);
    expect(standingFromDay(part, wed, S(40, 21, 12))).toEqual([D(40), D(21, [3, 5]), D(12, [1, 3])]);
    // without stop weekdays it is the saved list
    expect(standingFromDay(R(1, '2026-11-11', null, [1, 3, 5], S(12, 40)), wed, S(40, 70))).toEqual(S(40, 70));
  });
  it('dayEffects: who gains or loses that weekday', () => {
    expect(dayEffects(part, wed, S(40, 21, 12))).toEqual({ gains: [D(12, [1])], loses: [] });
    expect(dayEffects(part, wed, S(40))).toEqual({ gains: [], loses: [D(21, [3, 5])] });
    expect(dayEffects(part, wed, S(40, 21))).toEqual({ gains: [], loses: [] });
    // a stop whose only day it is simply leaves the route
    expect(dayEffects(R(1, '2026-11-11', null, [1, 3, 5], [D(21, [3])]), wed, [])).toEqual({ gains: [], loses: [] });
  });
  it('keptListsFollowing compares a later part with the standing list, not with the date\'s list', () => {
    const parts = [part, R(2, '2026-12-07', null, [1, 3, 5], [D(12, [1]), D(40), D(21, [3, 5])])];
    expect(keptListsFollowing(parts, 1, S(40, 21), wed)).toEqual([]); // 12 is not on the Wednesday list, but is on the route
  });
  it('daysReset: the customers whose weekdays a route-weekday change removes, per part and in a created part', () => {
    const parts = [R(1, '2026-11-11', '2026-11-29', [1, 3, 5], [D(12, [1, 5]), D(40, [5]), D(21)]), R(2, '2026-11-30', null, [1, 3, 5], [D(40), D(12, [5])])];
    expect(daysReset(parts, afterPatch(parts, 1, { days: [1, 3] }))).toEqual([40, 12]);
    expect(daysReset(parts, afterPatch(parts, 1, { days: [1, 3, 5, 6] }))).toEqual([]);
    expect(daysReset(parts, afterSplit(parts, { from: '2026-11-20', days: [2, 4] }, today))).toEqual([12, 40]);
    expect(daysReset(parts, null)).toEqual([]);
  });
});
