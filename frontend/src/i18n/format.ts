// Display formatting of server dates and times (§9.1): "11月11日 周三" / "Wed 11 Nov".
// Display only: rules (today, day class, locks) always come from the server. Dates stay
// 'YYYY-MM-DD' strings; the weekday is computed in UTC so the browser's time zone never matters.
import type { Lang } from '../api';

const WD_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WD_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON_EN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

/** ISO weekday 1 = Monday … 7 = Sunday of a 'YYYY-MM-DD' date (display only). */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function weekdayName(dow: number, lang: Lang): string {
  return (lang === 'zh' ? WD_ZH : WD_EN)[dow] ?? '';
}

/** A list of ISO weekdays as "Mon Wed Fri" / "周一 周三 周五". */
export function weekdayList(days: number[], lang: Lang): string {
  return days.map((d) => weekdayName(d, lang)).join(lang === 'zh' ? '、' : ' ');
}

export interface DayFormat {
  weekday?: boolean; // default true
  year?: boolean; // default false
  dow?: number; // use the server's dow instead of computing it
}

/** "11月11日 周三" / "Wed 11 Nov" (with year: "2026年11月11日 周三" / "Wed 11 Nov 2026"). */
export function fmtDay(date: string, lang: Lang, opts: DayFormat = {}): string {
  if (!date) return '';
  const [y, m, d] = parts(date);
  const withWd = opts.weekday !== false;
  const dow = opts.dow ?? (withWd ? weekdayOf(date) : 0);
  if (lang === 'zh') {
    return `${opts.year ? `${y}年` : ''}${m}月${d}日${withWd ? ' ' + WD_ZH[dow] : ''}`;
  }
  return `${withWd ? WD_EN[dow] + ' ' : ''}${d} ${MON_EN[m]}${opts.year ? ' ' + y : ''}`;
}

const MONTH_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Month 1–12 as "11月" / "November" (short: "Nov"). */
export function monthName(m: number, lang: Lang, short = false): string {
  if (lang === 'zh') return `${m}月`;
  return (short ? MON_EN : MONTH_EN)[m] ?? '';
}

/** Month-grid label of the 1st of a month: "11月1日" / "Nov 1" (§9.2). */
export function fmtMonthStart(date: string, lang: Lang): string {
  const [, m, d] = parts(date);
  return lang === 'zh' ? `${m}月${d}日` : `${MON_EN[m]} ${d}`;
}

/** 'HH:MM' of a server timestamp ('2026-11-11T07:52:00+08:00' -> '07:52'), in the server's offset. */
export function fmtTime(iso: string | null | undefined): string {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : '';
}

/** "11月11日 07:52" / "11 Nov 07:52". */
export function fmtDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '';
  return `${fmtDay(iso.slice(0, 10), lang, { weekday: false })} ${fmtTime(iso)}`;
}

/** An hour 0–23 as '04:00'. */
export function fmtHour(h: number): string {
  return String(h).padStart(2, '0') + ':00';
}

/** Weight with thousands separators and one decimal at most: 2410 -> "2,410", 420.5 -> "420.5". */
export function fmtWeight(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
