// Small text helpers shared by office pages.
import type { Lang, RemovedItem, WasteType } from '../api';
import { fmtDay } from '../i18n';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** One line for an item removed (or to be removed) by a customer detach / archive (R4). */
export function removedItemText(item: RemovedItem, t: T, lang: Lang): string {
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
