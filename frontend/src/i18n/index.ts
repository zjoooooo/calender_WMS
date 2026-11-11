// zh / en dictionaries with a tiny t(key, vars) (§9.1, §11.1). The dictionaries are split by area so
// several people can add keys without touching the same file: common.*, office.*, driver.*.
// Per-user language: the session sets it from /api/me; before login the browser's last choice
// (localStorage 'wms.lang') is used, default zh (R33).
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { prefs, type Lang } from '../api';
import commonZh from './common.zh';
import commonEn from './common.en';
import officeZh from './office.zh';
import officeEn from './office.en';
import driverZh from './driver.zh';
import driverEn from './driver.en';
import { fmtDay, type DayFormat } from './format';

export * from './format';

export type Dict = Record<string, string>;
export type Vars = Record<string, string | number>;

/** Every area's dictionaries, for the key-parity test. */
export const AREAS: Record<string, Record<Lang, Dict>> = {
  common: { zh: commonZh, en: commonEn },
  office: { zh: officeZh, en: officeEn },
  driver: { zh: driverZh, en: driverEn },
};

function merge(lang: Lang): Dict {
  const out: Dict = {};
  for (const area of Object.values(AREAS)) Object.assign(out, area[lang]);
  return out;
}

export const DICTS: Record<Lang, Dict> = { zh: merge('zh'), en: merge('en') };
export const LANGS: Lang[] = ['zh', 'en'];

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translates `key`; an unknown key returns the key itself (so a missing text is visible). */
export function translate(lang: Lang, key: string, vars?: Vars): string {
  const text = DICTS[lang][key] ?? DICTS.zh[key];
  return text === undefined ? key : interpolate(text, vars);
}

export function storedLang(): Lang {
  const v = prefs.get('lang');
  return v === 'en' || v === 'zh' ? v : 'zh';
}

export interface I18n {
  lang: Lang;
  /** Changes the UI language locally (and remembers it in this browser). The session also saves it on the user. */
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Vars) => string;
  day: (date: string, opts?: DayFormat) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial ?? storedLang());
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    prefs.set('lang', l);
    if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh' : 'en';
  }, []);
  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, vars) => translate(lang, key, vars),
      day: (date, opts) => fmtDay(date, lang, opts),
    }),
    [lang, setLang],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18n {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
