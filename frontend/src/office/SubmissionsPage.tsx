// Office "Submissions" page (read only): the drivers' free submissions of the non-routable waste types
// (OTC, COMPACTOR, EROSE …) of one operational day. Nothing is planned for these types: a driver submits
// them on the phone at any time. They count in the calendar's day totals but have no line on the calendar,
// so this page is where the office sees them one by one.
// - ?date=YYYY-MM-DD (default: today, from the server); ‹ › move one day.
// - Filters on the loaded day: waste type, driver, customer (name or code).
// - A row opens its details: photos, signature, note, weighbridge ticket and the change history.
import { Fragment, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { listSubmissions, type OfficeSubmissions } from '../api';
import { fmtDateTime, fmtDay, fmtTime, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { WasteTag } from '../ui/Chip';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { useFileUrl } from '../ui/useFileUrl';
import { addDays } from './calendarModel';
import { typeMap } from './labels';
import { totalsText } from './officeShared';
import './office.css';

type Row = OfficeSubmissions['submissions'][number];

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
  const [type, setType] = useState('');
  const [driver, setDriver] = useState('');
  const [cust, setCust] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const all = q.data?.submissions ?? [];
  const typeCodes = useMemo(() => [...new Set(all.map((s) => s.waste_type))], [all]);
  const drivers = useMemo(() => [...new Set(all.map((s) => s.driver ?? ''))].filter(Boolean).sort(), [all]);
  const needle = cust.trim().toLowerCase();
  const rows = all.filter(
    (s) =>
      (!type || s.waste_type === type) &&
      (!driver || s.driver === driver) &&
      (!needle || s.customer.name.toLowerCase().includes(needle) || s.customer.code.toLowerCase().includes(needle)),
  );
  // Totals of the rows shown (the unfiltered day totals are the server's `totals`).
  const totals: Record<string, number> = {};
  for (const s of rows) for (const [k, w] of Object.entries(s.weights)) totals[k] = Math.round(((totals[k] ?? 0) + Number(w)) * 10) / 10;

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
                <Fragment key={s.id}>
                  <tr data-id={s.id} data-type={s.waste_type}>
                    <td className="nowrap num">{fmtTime(s.captured_at ?? s.received_at)}</td>
                    <td>
                      <WasteTag code={s.waste_type} abbr={types[s.waste_type]?.abbr} />
                    </td>
                    <td>
                      <strong>{s.customer.name}</strong> <span className="muted code small">{s.customer.code}</span>
                    </td>
                    <td className="num">
                      {fmtWeight(Number(s.weights[s.waste_type] ?? 0))} {types[s.waste_type]?.unit ?? 'kg'}
                    </td>
                    <td className="small">{s.tickets[s.waste_type] ?? '–'}</td>
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
                      <button type="button" className="btn small" aria-expanded={openId === s.id} onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                        {t('subs.details')}
                      </button>
                    </td>
                  </tr>
                  {openId === s.id && (
                    <tr className="subs-detail">
                      <td colSpan={9}>
                        <Details s={s} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    {t(all.length ? 'subs.noneFiltered' : 'subs.none')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Details({ s }: { s: Row }) {
  const { t, lang } = useI18n();
  const history = s.history ?? [];
  return (
    <div className="stack" data-testid="subs-details">
      <div className="small muted">
        {s.customer.address}
        {s.note ? ` · ${t('common.note')}: ${s.note}` : ''}
        {` · ${t('subs.received', { time: fmtDateTime(s.received_at, lang) })}`}
      </div>
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
              {fmtDateTime(h.at, lang)} · rev {h.rev} ·{' '}
              {h.outcome === 'collected'
                ? Object.entries(h.weights ?? {})
                    .map(([k, v]) => `${k} ${fmtWeight(Number(v))}`)
                    .join(' · ')
                : t('subs.deleted')}
              {h.note ? ` · ${h.note}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
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
