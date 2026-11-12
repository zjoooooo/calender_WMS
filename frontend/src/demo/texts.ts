// zh / en texts of the demo's own screens (loading, banner). Demo build only, so they are not in src/i18n
// (the normal build carries no demo text). The type makes tsc refuse a key missing in one language.
import type { Lang } from '../api';

const zh = {
  title: 'WMS 路线日历 · 演示',
  'load.runtime': '正在下载 PHP 运行环境（只有第一次较慢，之后浏览器会缓存）',
  'load.size': '{done} / {total} MB',
  'load.data': '正在载入演示数据…',
  'load.start': '正在启动后端…',
  'load.signin': '正在打开日历…',
  'error.title': '演示无法启动',
  'error.hint': '请使用较新版本的 Chrome、Edge、Firefox 或 Safari，然后重试。',
  'error.retry': '重试',
  'bar.text': '演示版：示例数据，无需登录。你的修改只保存在这个浏览器里。',
  'bar.textDriver': '司机端演示：你是司机 Bala，无需登录。你的修改只保存在这个浏览器里，办公室演示里也能看到。',
  'bar.toDriver': '司机端演示 →',
  'bar.toOffice': '← 办公室日历演示',
  'bar.reset': '重置演示数据',
  'bar.resetTitle': '重置演示数据',
  'bar.resetText': '删除你在这个浏览器里做的所有修改，恢复原始演示数据？',
  'bar.reload': '刷新本页',
  'notice.updated': '演示已更新，之前的修改已重置。',
  'notice.restored': '保存的修改无法打开，已恢复原始演示数据。',
  'notice.noStorage': '这个浏览器不允许保存数据：刷新页面后修改会丢失。',
  'notice.otherTab': '演示在另一个标签页里被修改了，这里的修改不再保存。请刷新本页，使用最新的数据。',
} as const;

const en: { [K in keyof typeof zh]: string } = {
  title: 'WMS Route Calendar · Demo',
  'load.runtime': 'Downloading the PHP runtime (slow only the first time; the browser keeps it)',
  'load.size': '{done} / {total} MB',
  'load.data': 'Loading the demo data…',
  'load.start': 'Starting the backend…',
  'load.signin': 'Opening the calendar…',
  'error.title': 'The demo could not start',
  'error.hint': 'Please use a recent Chrome, Edge, Firefox or Safari and try again.',
  'error.retry': 'Try again',
  'bar.text': 'Demo with sample data, no sign-in. Your changes stay only in this browser.',
  'bar.textDriver': 'Driver app demo: you are the driver Bala, no sign-in. Your changes stay only in this browser, and the office demo shows them too.',
  'bar.toDriver': 'Driver app demo →',
  'bar.toOffice': '← Office calendar demo',
  'bar.reset': 'Reset demo data',
  'bar.resetTitle': 'Reset demo data',
  'bar.resetText': 'Remove all your changes in this browser and restore the original demo data?',
  'bar.reload': 'Reload this page',
  'notice.updated': 'The demo was updated, so your earlier changes were reset.',
  'notice.restored': 'Your saved changes could not be opened, so the original demo data was restored.',
  'notice.noStorage': 'This browser does not allow saving here: your changes are lost when you reload.',
  'notice.otherTab': 'The demo was changed in another tab, so changes here are no longer saved. Reload this page to use the latest data.',
};

export type DemoKey = keyof typeof zh;
export const DEMO_TEXTS: Record<Lang, Record<DemoKey, string>> = { zh, en };

export function demoText(lang: Lang, key: DemoKey, vars?: Record<string, string | number>): string {
  return DEMO_TEXTS[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
}
