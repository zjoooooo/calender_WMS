import { describe, expect, it } from 'vitest';
import { rolloverDelayMs, todayChanged } from './rollover';

describe('rolloverDelayMs', () => {
  const meta = { now: '2026-11-12T03:59:00+08:00', day_ends_at: '2026-11-12T04:00:00+08:00' };

  it('waits for day_ends_at - now from the server, plus a margin', () => {
    expect(rolloverDelayMs(meta, 1000, 1000)).toBe(60_000 + 2000);
  });

  it('subtracts the time since the response arrived (local clock only measures elapsed time)', () => {
    expect(rolloverDelayMs(meta, 1000, 1000 + 30_000)).toBe(30_000 + 2000);
  });

  it('never returns less than 1 s, or more than the setTimeout limit', () => {
    expect(rolloverDelayMs(meta, 0, 10 * 60_000)).toBe(1000);
    const far = { now: '2026-11-11T07:40:00+08:00', day_ends_at: '2027-11-12T04:00:00+08:00' };
    expect(rolloverDelayMs(far, 0, 0)).toBe(2_147_000_000);
  });
});

describe('todayChanged', () => {
  it('is true only when a known today differs', () => {
    expect(todayChanged('2026-11-11', '2026-11-12')).toBe(true);
    expect(todayChanged('2026-11-11', '2026-11-11')).toBe(false);
    expect(todayChanged(undefined, '2026-11-12')).toBe(false);
  });
});
