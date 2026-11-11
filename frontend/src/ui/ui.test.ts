import { describe, expect, it } from 'vitest';
import { randomPassword, uuidv4, UUID_V4_RE } from './uuid';
import { fitWithin, PHOTO_MAX_EDGE } from './photo';
import { routeColor, routeColorVar, ROUTE_COLORS } from './palette';

describe('uuidv4', () => {
  it('produces lowercase v4 UUIDs that differ', () => {
    const a = uuidv4();
    const b = uuidv4();
    expect(a).toMatch(UUID_V4_RE);
    expect(b).toMatch(UUID_V4_RE);
    expect(a).not.toBe(b);
  });

  it('random passwords are 12 characters by default', () => {
    expect(randomPassword()).toMatch(/^[A-Za-z2-9]{12}$/);
  });
});

describe('fitWithin (photo resize)', () => {
  it('scales the long edge down to 1600 and keeps the ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: PHOTO_MAX_EDGE, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: PHOTO_MAX_EDGE });
  });
  it('never upscales', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('palette', () => {
  it('has the 10 mockup colours and clamps bad indexes', () => {
    expect(ROUTE_COLORS).toHaveLength(10);
    expect(routeColor(1)).toBe('#4E79A7');
    expect(routeColor(10)).toBe('#17BECF');
    expect(routeColor(0)).toBe('#4E79A7');
    expect(routeColorVar(7)).toBe('var(--r7)');
  });
});
