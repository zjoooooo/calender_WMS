// Office "Submissions" page (read only): everything the drivers recorded on one operational day.
// - Route records: the result of each stop on that day's routes (REL, Recycling; regular, special and adhoc
//   routes), collected or not collected.
// - Free submissions of the non-routable waste types (OTC, COMPACTOR, EROSE …): nothing is planned for
//   them, a driver submits them on the phone at any time. They count in the calendar's day totals but
//   have no line on the calendar, so this page is where the office sees them one by one.
// - ?date=YYYY-MM-DD (default: today, from the server); ‹ › move one day.
// - Filters on the loaded day: source (routes / no route), waste type, driver, customer (name or code).
// - [Details] opens the record as a small document over the dimmed page: photos, signature, note, ticket
//   and the change history, with [Print] and [Save] (a file that opens in any browser, photos included).
//   It closes only with [Close].
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { fetchFileBlob, listSubmissions, type Lang, type OfficeSubmissions, type RouteRecord, type WasteType } from '../api';
import { fmtDateTime, fmtDay, fmtTime, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { TypeTag, WasteTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useFileUrl } from '../ui/useFileUrl';
import { addDays } from './calendarModel';
import { typeMap } from './labels';
import { totalsText } from './officeShared';
import './office.css';

type Free = OfficeSubmissions['submissions'][number];
/** One line of the page: a route record or a free submission. */
export type Row = (Free & { route?: undefined }) | RouteRecord;
type T = (key: string, vars?: Record<string, string | number>) => string;

const isRoute = (r: Row): r is RouteRecord => !!r.route;

/** Both lists as one, by the time the server received them. */
export function mergeRows(data: Pick<OfficeSubmissions, 'submissions' | 'visits'> | undefined): Row[] {
  const rows: Row[] = [...(data?.visits ?? []), ...(data?.submissions ?? [])];
  return rows.sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : a.id < b.id ? -1 : 1));
}

function weightText(r: Row, types: Record<string, WasteType>): string {
  return Object.entries(r.weights)
    .map(([k, w]) => `${fmtWeight(Number(w))} ${types[k]?.unit ?? 'kg'}`)
    .join(' · ');
}

export default function SubmissionsPage() {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const [params, setParams] = useSearchParams();
  const today = meta?.today ?? '';
  const date = params.get('date') || today;
  const setDate = (d: string) => setParams(d && d !== today ? { date: d } : {}, { replace: true });

  const q = useQuery({
    queryKey: ['submissions', date],
    queryFn: () => listSubmissions(date),
    enabled: !!date,
    placeholderData: keepPreviousData,
    refetchInterval: date === today ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
  const types = typeMap(meta?.waste_types);
  const [source, setSource] = useState<'' | 'route' | 'free'>('');
  const [type, setType] = useState('');
  const [driver, setDriver] = useState('');
  const [cust, setCust] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const all = useMemo(() => mergeRows(q.data), [q.data]);
  const typeCodes = useMemo(() => [...new Set(all.map((s) => s.waste_type))], [all]);
  const drivers = useMemo(() => [...new Set(all.map((s) => s.driver ?? ''))].filter(Boolean).sort(), [all]);
  const needle = cust.trim().toLowerCase();
  const rows = all.filter(
    (s) =>
      (!source || (source === 'route') === isRoute(s)) &&
      (!type || s.waste_type === type) &&
      (!driver || s.driver === driver) &&
      (!needle || s.customer.name.toLowerCase().includes(needle) || s.customer.code.toLowerCase().includes(needle)),
  );
  // Totals of the rows shown.
  const totals: Record<string, number> = {};
  for (const s of rows) for (const [k, w] of Object.entries(s.weights)) totals[k] = Math.round(((totals[k] ?? 0) + Number(w)) * 10) / 10;
  const open = openId ? all.find((s) => s.id === openId) : undefined;

  return (
    <>
      <div className="page-head">
        <h1>{t('subs.title')}</h1>
        <div className="calnav" role="group">
          <button type="button" className="btn" aria-label={t('cal.prev')} onClick={() => setDate(addDays(date, -1))}>
            ‹
          </button>
          <button type="button" className="btn" onClick={() => setDate(today)}>
            {t('common.today')}
          </button>
          <button type="button" className="btn" aria-label={t('cal.next')} disabled={date >= today} onClick={() => setDate(addDays(date, 1))}>
            ›
          </button>
        </div>
        <input type="date" className="input" style={{ width: 170 }} value={date} max={today} aria-label={t('common.date')} onChange={(e) => e.target.value && setDate(e.target.value)} />
        {date && <strong>{fmtDay(date, lang, { year: true })}</strong>}
        <span className="spacer" />
        <span className="muted small num" data-testid="subs-count">
          {q.data ? t('subs.count', { n: rows.length }) : ''}
          {rows.length > 0 ? ` · ${totalsText(totals, meta?.waste_types)}` : ''}
        </span>
      </div>

      <div className="cal-bar">
        <select className="input" style={{ width: 'auto' }} value={source} onChange={(e) => setSource(e.target.value as '' | 'route' | 'free')} aria-label={t('subs.colRoute')}>
          <option value="">{t('subs.allSources')}</option>
          <option value="route">{t('subs.srcRoute')}</option>
          <option value="free">{t('subs.srcFree')}</option>
        </select>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('subs.colType')}>
          <option value="">{t('customers.allTypes')}</option>
          {typeCodes.map((c) => (
            <option key={c} value={c}>
              {types[c]?.abbr || c}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 'auto' }} value={driver} onChange={(e) => setDriver(e.target.value)} aria-label={t('subs.colDriver')}>
          <option value="">{t('subs.allDrivers')}</option>
          {drivers.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input className="search" type="search" value={cust} placeholder={t('subs.customerPlaceholder')} aria-label={t('subs.colCustomer')} onChange={(e) => setCust(e.target.value)} />
      </div>

      <div className="note">{t('subs.hint')}</div>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}

      {q.data && (
        <div className="table-wrap">
          <table className="table" data-testid="subs-table">
            <thead>
              <tr>
                <th>{t('subs.colTime')}</th>
                <th>{t('subs.colRoute')}</th>
                <th>{t('subs.colType')}</th>
                <th>{t('subs.colCustomer')}</th>
                <th className="num">{t('subs.colWeight')}</th>
                <th>{t('subs.colTicket')}</th>
                <th>{t('subs.colPlate')}</th>
                <th>{t('subs.colDriver')}</th>
                <th>{t('subs.colFiles')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-id={s.id} data-type={s.waste_type} data-source={isRoute(s) ? 'route' : 'free'}>
                  <td className="nowrap num">{fmtTime(s.captured_at ?? s.received_at)}</td>
                  <td className="nowrap">
                    {isRoute(s) ? (
                      <span title={s.route.name}>
                        <span className="code">{s.route.code}</span> <TypeTag type={s.route.type} />
                      </span>
                    ) : (
                      <span className="muted small">{t('subs.noRoute')}</span>
                    )}
                  </td>
                  <td>
                    <WasteTag code={s.waste_type} abbr={types[s.waste_type]?.abbr} />
                  </td>
                  <td>
                    <strong>{s.customer.name}</strong> <span className="muted code small">{s.customer.code}</span>
                  </td>
                  <td className="num">{s.outcome === 'missed' ? <span className="vis-miss">✗ {s.reason ? t(`reason.${s.reason}`) : t('status.notCollected')}</span> : weightText(s, types)}</td>
                  <td className="small">{Object.values(s.tickets).join(', ') || '–'}</td>
                  <td className="code small">{s.vehicle_no ?? '–'}</td>
                  <td>{s.driver ?? '–'}</td>
                  <td className="small nowrap">
                    {s.photos.length > 0 ? `📷${s.photos.length} ` : ''}
                    {s.signature ? '✍ ' : ''}
                    {s.flags.map((f) => (
                      <span key={f} className="flag">
                        {f}
                      </span>
                    ))}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn small" onClick={() => setOpenId(s.id)}>
                      {t('subs.details')}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    {t(all.length ? 'subs.noneFiltered' : 'subs.none')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {open && <RecordDialog key={open.id} row={open} types={types} onClose={() => setOpenId(null)} />}
    </>
  );
}

/** label / value pairs of a record, shared by the dialog and the saved file. */
function recordFields(s: Row, types: Record<string, WasteType>, t: T, lang: Lang): [string, string][] {
  const wt = types[s.waste_type];
  const out: [string, string][] = [
    [t('common.date'), fmtDay(s.date, lang, { year: true })],
    [t('subs.colTime'), fmtDateTime(s.captured_at ?? s.received_at, lang)],
    [t('subs.colRoute'), isRoute(s) ? `${s.route.code} (${t(`type.${s.route.type}`)}) · ${s.route.name}` : t('subs.noRoute')],
    [t('subs.colType'), wt ? `${wt.name} (${wt.abbr})` : s.waste_type],
    [t('subs.colCustomer'), `${s.customer.name} · ${s.customer.code}`],
    [t('customers.colAddress'), s.customer.address || '–'],
    [t('subs.colWeight'), s.outcome === 'missed' ? `✗ ${s.reason ? t(`reason.${s.reason}`) : t('status.notCollected')}` : weightText(s, types)],
    [t('subs.colTicket'), Object.values(s.tickets).join(', ') || '–'],
    [t('subs.colPlate'), s.vehicle_no ?? '–'],
    [t('subs.colDriver'), s.driver ?? '–'],
    [t('common.note'), s.note || '–'],
  ];
  if (s.flags.length) out.push([t('subs.flags'), s.flags.join(', ')]);
  return out;
}

const historyText = (h: NonNullable<Row['history']>[number], t: T, lang: Lang) =>
  `${fmtDateTime(h.at, lang)} · rev ${h.rev} · ` +
  (h.outcome === 'collected'
    ? Object.entries(h.weights ?? {})
        .map(([k, v]) => `${k} ${fmtWeight(Number(v))}`)
        .join(' · ')
    : h.outcome === 'missed'
      ? t('status.notCollected')
      : t('subs.deleted')) +
  (h.note ? ` · ${h.note}` : '');

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/** The record as one self-contained HTML file (photos and signature inside it). */
export async function recordHtml(s: Row, title: string, fields: [string, string][], history: string[], texts: { photos: string; signature: string; history: string }): Promise<string> {
  const img = async (path: string) => `<img src="${await dataUrl(await fetchFileBlob(path))}" alt="">`;
  const photos = await Promise.all(s.photos.map(img));
  const sig = s.signature ? await img(s.signature) : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#18202b}
h1{font-size:20px}h2{font-size:15px;margin-top:20px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #d9dee5;vertical-align:top}th{width:34%;color:#5b6573;font-weight:600}
img{max-width:100%;max-height:420px;margin:4px 8px 4px 0;border:1px solid #d9dee5}li{margin:2px 0}
</style></head><body><h1>${esc(title)}</h1><table>${fields.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${photos.length ? `<h2>${esc(texts.photos)}</h2>${photos.join('')}` : ''}${sig ? `<h2>${esc(texts.signature)}</h2>${sig}` : ''}
${history.length ? `<h2>${esc(texts.history)}</h2><ul>${history.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}</body></html>`;
}

/** One record as a small document over the dimmed page. Only [Close] closes it (no ✕, no Esc, no click outside). */
function RecordDialog({ row: s, types, onClose }: { row: Row; types: Record<string, WasteType>; onClose: () => void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const fields = recordFields(s, types, t, lang);
  const history = (s.history ?? []).map((h) => historyText(h, t, lang));
  const title = `${t('subs.record')} · ${s.customer.name} · ${types[s.waste_type]?.abbr || s.waste_type} · ${s.date}`;

  const save = async () => {
    setSaving(true);
    try {
      const html = await recordHtml(s, title, fields, history, { photos: t('result.photos'), signature: t('result.signature'), history: t('result.history') });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `record-${s.date}-${s.customer.code || s.customer_id}-${s.waste_type}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast(t('subs.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      noClose
      className="print-doc"
      width={640}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-testid="subs-print" onClick={() => window.print()}>
            {t('subs.print')}
          </button>
          <button type="button" className="btn" data-testid="subs-save" disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </button>
          <button type="button" className="btn primary" data-testid="subs-close" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className="stack" data-testid="subs-details">
        <table className="table">
          <tbody>
            {fields.map(([k, v]) => (
              <tr key={k}>
                <th style={{ width: '34%' }}>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(s.photos.length > 0 || s.signature) && (
          <div className="thumbs">
            {s.photos.map((p) => (
              <FileThumb key={p} path={p} label={t('result.photos')} />
            ))}
            {s.signature && <FileThumb path={s.signature} label={t('result.signature')} />}
          </div>
        )}
        {history.length > 0 && (
          <div className="history">
            <div className="muted small">{t('result.history')}</div>
            {history.map((h, i) => (
              <div key={i} className="h">
                {h}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** A stored photo or signature; a click opens it full size in a new tab. */
function FileThumb({ path, label }: { path: string; label: string }) {
  const { url } = useFileUrl(path);
  return (
    <div className="thumb" title={label}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={label} />
        </a>
      ) : (
        '…'
      )}
    </div>
  );
}
