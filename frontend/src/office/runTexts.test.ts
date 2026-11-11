// Run status texts after the office takes a job back (K5, SPLIT-UI-09) and the R26 refusal when no driver
// holds the job any more (SPLIT-UI-10).
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../api';
import { statusText } from '../driver/parts';
import { translate } from '../i18n';
import { runDetailText } from './officeShared';
import { runExistsLine, runExistsTitle } from './RunExistsDialog';

const en = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const zh = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
const run = (x: Partial<RunSummary>): RunSummary => ({
  driver: null,
  vehicle_no: 'SBA1234X',
  holders: ['Bala'],
  left_by: null,
  collected: 3,
  missed: 0,
  pending: 7,
  total: 10,
  totals: {},
  last_activity_at: null,
  flagged: 0,
  ...x,
});

describe('a job the office took back', () => {
  it('office drawer / tooltip: "Needs driver · taken back by office · 3/10"', () => {
    expect(runDetailText('open', run({ released_by_office: true }), en, [])).toBe('Needs driver · taken back by office · 3/10');
    expect(runDetailText('open', run({ released_by_office: true }), zh, [])).toContain('办公室已收回');
  });
  it('a driver who left it is still named; an older server without the field shows the plain status', () => {
    expect(runDetailText('open', run({ left_by: 'Bala' }), en, [])).toBe('Needs driver · left by Bala · 3/10');
    expect(runDetailText('open', run({}), en, [])).toBe('Needs driver · 3/10');
  });
  it('driver Today card: "⇄ Needs driver 3/10 · taken back by office"', () => {
    expect(statusText(en, 'open', { mine: false, resolved: 3, total: 10, byOffice: true, kind: 'route' })).toBe('⇄ Needs driver 3/10 · taken back by office');
    expect(statusText(zh, 'open', { mine: false, resolved: 3, total: 10, byOffice: true, kind: 'route' })).toContain('办公室已收回');
    expect(statusText(en, 'open', { mine: false, resolved: 3, total: 10, leftBy: 'Bala', byOffice: false, kind: 'route' })).toBe('⇄ Needs driver 3/10 · left by Bala');
  });
});

describe('R26 refusal (RUN_EXISTS)', () => {
  it('nobody holds the job, 3 stops done: names the done stops, not "nobody has done 3"', () => {
    const r = { job: 'r4', code_or_customer: 'E1', driver: null, resolved: 3 };
    expect(runExistsTitle(en, [r])).toBe('Work is already done on this job today');
    expect(runExistsLine(en, r)).toMatch(/^Refused: 3 stops of E1 are already done today \(no driver holds it now\)\./);
    expect(runExistsLine(en, r)).not.toMatch(/nobody/);
  });
  it('a driver holds it: the texts are unchanged', () => {
    const held = { job: 'r10', code_or_customer: 'C1', driver: 'Devi', resolved: 0 };
    expect(runExistsTitle(en, [held])).toBe('A driver has this job');
    expect(runExistsLine(en, held)).toBe('Devi has C1 (0 done).');
    expect(runExistsLine(en, { ...held, driver: 'Bala', resolved: 3 })).toMatch(/^Refused: Bala has done 3 on C1\./);
  });
});
