// Small text helpers shared by office pages.
import type { Lang, RemovedItem, TaskSchedule, WasteType } from '../api';
import { fmtDay, weekdayList } from '../i18n';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "Once Sat 15 Nov" / "Tue Fri from 17 Nov until 31 Dec" (§9.2 Tasks page wording). */
export function taskScheduleText(s: TaskSchedule, t: T, lang: Lang): string {
  if ('date' in s) return t('sched.once', { date: fmtDay(s.date, lang) });
  let text = t('sched.weekly', { days: weekdayList(s.days ?? [], lang), start: s.start ? fmtDay(s.start, lang, { weekday: false }) : '' });
  if (s.end) text += ' ' + t('sched.until', { end: fmtDay(s.end, lang, { weekday: false }) });
  return text;
}

/** One line for an item removed (or to be removed) by a customer detach / archive (R4). */
export function removedItemText(item: RemovedItem, t: T, lang: Lang): string {
  if (item.kind === 'task') {
    return t(item.action === 'ended' ? 'customers.removedTaskEnded' : 'customers.removedTaskDeleted', { type: item.waste_type, id: item.task_id });
  }
  const date = item.date ? fmtDay(item.date, lang) : '';
  if (item.where === 'override') return t('customers.removedOverride', { code: item.code, date });
  if (item.where === 'one-off') return t('customers.removedOneOff', { code: item.code, date });
  return t('customers.removedTemplate', { code: item.code });
}

/** code -> waste type. */
export function typeMap(types: WasteType[] | undefined): Record<string, WasteType> {
  const m: Record<string, WasteType> = {};
  for (const w of types ?? []) m[w.code] = w;
  return m;
}

/** "REL" or "REL / GLS": the active routable types, for hints. */
export function routableNames(types: WasteType[] | undefined): string {
  return (types ?? []).filter((w) => w.routable && w.active).map((w) => w.abbr || w.code).join(' / ') || 'REL';
}
