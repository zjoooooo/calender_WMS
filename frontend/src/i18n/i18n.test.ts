// i18n key parity (§11.1, §13): zh and en have the same keys in every area, no key is defined in two
// areas, placeholders match, and every API error code has a text.
import { describe, expect, it } from 'vitest';
import { AREAS, DICTS, interpolate, translate } from './index';
import { fmtDay, fmtMonthStart, monthName, weekdayOf } from './format';
import { ERROR_CODES, WARNING_CODES } from '../api';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n dictionaries', () => {
  for (const [area, { zh, en }] of Object.entries(AREAS)) {
    it(`${area}: zh and en have identical keys`, () => {
      const zk = Object.keys(zh).sort();
      const ek = Object.keys(en).sort();
      expect(zk.filter((k) => !(k in en)), `missing in ${area}.en`).toEqual([]);
      expect(ek.filter((k) => !(k in zh)), `missing in ${area}.zh`).toEqual([]);
      expect(ek).toEqual(zk);
    });

    it(`${area}: placeholders match and no text is empty`, () => {
      for (const k of Object.keys(zh)) {
        expect(zh[k].trim(), `${area}.zh ${k}`).not.toBe('');
        expect(en[k].trim(), `${area}.en ${k}`).not.toBe('');
        expect(placeholders(en[k]), `placeholders of ${k}`).toEqual(placeholders(zh[k]));
      }
    });
  }

  it('no key is defined in two areas', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [area, { zh }] of Object.entries(AREAS)) {
      for (const k of Object.keys(zh)) {
        if (seen.has(k)) dupes.push(`${k} (${seen.get(k)} and ${area})`);
        seen.set(k, area);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every error and warning code has a text in both languages', () => {
    for (const code of ERROR_CODES) {
      expect(DICTS.zh[`err.${code}`], `err.${code}`).toBeTruthy();
      expect(DICTS.en[`err.${code}`], `err.${code}`).toBeTruthy();
    }
    for (const code of WARNING_CODES) {
      expect(DICTS.zh[`warn.${code}`], `warn.${code}`).toBeTruthy();
      expect(DICTS.en[`warn.${code}`], `warn.${code}`).toBeTruthy();
    }
  });
});

describe('translate and format', () => {
  it('interpolates variables and leaves unknown ones', () => {
    expect(interpolate('Try again at {time}', { time: '07:52' })).toBe('Try again at 07:52');
    expect(interpolate('{a} {b}', { a: 1 })).toBe('1 {b}');
    expect(translate('en', 'err.ACCOUNT_LOCKED', { time: '07:52' })).toBe('Too many wrong passwords. Try again at 07:52');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('uses the singular text for n = 1 when there is one (OFF-9)', () => {
    expect(translate('en', 'cal.nTasks', { n: 1 })).toBe('1 task');
    expect(translate('en', 'cal.nTasks', { n: 2 })).toBe('2 tasks');
    expect(translate('en', 'users.taskJobs', { n: 1 })).toBe('1 task');
    expect(translate('en', 'cal.moreN', { n: 1 })).toBe('1 more'); // no _one text: the plain one
    expect(translate('zh', 'cal.nTasks', { n: 1 })).toBe('1 个任务');
    expect(translate('en', 'err.required_field', { field: 'Name' })).toBe('Name is required');
  });

  it('formats dates per language without the browser time zone', () => {
    expect(weekdayOf('2026-11-11')).toBe(3);
    expect(weekdayOf('2026-11-15')).toBe(7);
    expect(fmtDay('2026-11-11', 'zh')).toBe('11月11日 周三');
    expect(fmtDay('2026-11-11', 'en')).toBe('Wed 11 Nov');
    expect(fmtDay('2026-12-25', 'en', { year: true })).toBe('Fri 25 Dec 2026');
  });

  it('formats month names and the month-grid label of the 1st', () => {
    expect(monthName(11, 'zh')).toBe('11月');
    expect(monthName(11, 'en')).toBe('November');
    expect(monthName(11, 'en', true)).toBe('Nov');
    expect(fmtMonthStart('2026-11-01', 'zh')).toBe('11月1日');
    expect(fmtMonthStart('2026-12-01', 'en')).toBe('Dec 1');
  });
});
