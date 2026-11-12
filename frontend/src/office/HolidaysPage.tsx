// Holidays page (§6.10, R16): one list per year; add, rename and delete for dates >= today; past rows
// show a lock. "+ Add" on a date that already has a holiday is refused on screen (use Rename). HOLIDAY_CONFLICT
// replaces the open confirm dialog and lists the one-off routes to change first (with links to the calendar);
// RUN_EXISTS opens the R26 dialog. A banner shows years in view or within 60 days with no holidays.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, deleteHoliday, isApiError, listHolidays, putHoliday, type Holiday, type HolidayConflictDetails } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { RouteCode, TypeTag } from '../ui/Chip';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { RunExistsDialog } from './RunExistsDialog';

type Action = { kind: 'put'; date: string; name: string; added: boolean } | { kind: 'delete'; date: string; name: string };

/** 'YYYY-MM-DD' + n days (UTC arithmetic, display only). */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export default function HolidaysPage() {
  const { t, day } = useI18n();
  const { meta } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const today = meta?.today ?? '';
  const todayYear = today ? Number(today.slice(0, 4)) : new Date().getFullYear();
  const [year, setYear] = useState<number>(todayYear);
  useEffect(() => setYear(todayYear), [todayYear]);

  // All holidays at once (a few dozen): counts per year and the missing-year banner need them.
  const listQ = useQuery({ queryKey: ['holidays'], queryFn: () => listHolidays() });
  const all = listQ.data ?? [];
  const byYear = useMemo(() => {
    const m = new Map<number, Holiday[]>();
    for (const h of all) {
      const y = Number(h.date.slice(0, 4));
      m.set(y, [...(m.get(y) ?? []), h]);
    }
    return m;
  }, [all]);
  const years = useMemo(() => {
    const s = new Set<number>([...byYear.keys(), todayYear, todayYear + 1]);
    return [...s].sort((a, b) => a - b);
  }, [byYear, todayYear]);
  const rows = (byYear.get(year) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));

  const missing = useMemo(() => {
    if (!listQ.data || !today) return [];
    const check = new Set([todayYear, Number(addDays(today, 60).slice(0, 4)), year]);
    return [...check].filter((y) => !byYear.has(y)).sort();
  }, [listQ.data, today, todayYear, year, byYear]);

  // Add form
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const existing = all.find((h) => h.date === newDate);
  const newIsPast = !!newDate && !!today && newDate < today;

  // Rename / delete / errors
  const [renaming, setRenaming] = useState<Holiday | null>(null);
  const [renameText, setRenameText] = useState('');
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ date: string; details: HolidayConflictDetails } | null>(null);
  const [runErr, setRunErr] = useState<{ error: ApiError; action: Action } | null>(null);

  const perform = async (a: Action, releaseRun = false): Promise<boolean> => {
    setBusy(true);
    setFormError(null);
    try {
      if (a.kind === 'put') {
        await putHoliday(a.date, releaseRun ? { name: a.name, release_run: true } : { name: a.name });
        toast(a.added ? t('holidays.added', { date: day(a.date), name: a.name }) : t('holidays.renamed'));
      } else {
        await deleteHoliday(a.date, releaseRun);
        toast(t('holidays.deleted', { date: day(a.date) }));
      }
      void qc.invalidateQueries({ queryKey: ['holidays'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      void qc.invalidateQueries({ queryKey: ['meta'] }); // next_work_day may change
      return true;
    } catch (e) {
      if (isApiError(e, 'HOLIDAY_CONFLICT')) {
        // Only the conflict dialog stays open, so Esc / Close leave nothing behind.
        setDeleting(null);
        setRenaming(null);
        setConflict({ date: a.date, details: e.details as HolidayConflictDetails });
      }
      else if (isApiError(e, 'RUN_EXISTS')) setRunErr({ error: e, action: a });
      else setFormError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newDate || !newName.trim() || newIsPast || existing) return;
    const ok = await perform({ kind: 'put', date: newDate, name: newName.trim(), added: true });
    if (ok) {
      setYear(Number(newDate.slice(0, 4)));
      setNewDate('');
      setNewName('');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('holidays.title')}</h1>
        <div className="row">
          <button type="button" className="btn" aria-label={t('holidays.prevYear')} onClick={() => setYear((y) => y - 1)}>
            ‹
          </button>
          <div className="tabs" role="tablist">
            {years.map((y) => (
              <button key={y} type="button" role="tab" aria-selected={y === year} onClick={() => setYear(y)}>
                {y} <span className="muted small">({byYear.get(y)?.length ?? 0})</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn" aria-label={t('holidays.nextYear')} onClick={() => setYear((y) => y + 1)}>
            ›
          </button>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="banner warn" role="status">
          {t('holidays.missing', { years: missing.join(', ') })}
        </div>
      )}
      <div className="note">{t('holidays.seeded')}</div>

      <form className="card row" onSubmit={submitAdd} noValidate style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ width: 180 }}>
          <span>{t('holidays.date')}</span>
          <input type="date" value={newDate} min={today || undefined} onChange={(e) => setNewDate(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <span>{t('holidays.name')}</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !newDate || !newName.trim() || newIsPast || !!existing}>
          + {t('holidays.addBtn')}
        </button>
        {(existing || newIsPast || formError) && (
          <div style={{ flexBasis: '100%' }} className="small">
            {newIsPast && <div className="form-error">{t('holidays.pastDate')}</div>}
            {existing && !newIsPast && (
              <div className="form-error" role="alert" data-testid="holiday-exists">
                {t('holidays.exists', { date: day(existing.date), name: existing.name })}
              </div>
            )}
            {formError && <div className="form-error" role="alert">{formError}</div>}
          </div>
        )}
      </form>

      <ErrorBanner error={listQ.error} onRetry={() => listQ.refetch()} />
      {listQ.isLoading && <Loading />}
      {listQ.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('holidays.date')}</th>
                <th>{t('holidays.name')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    {t('holidays.none', { year })}
                  </td>
                </tr>
              )}
              {rows.map((h) => {
                const past = h.past ?? (!!today && h.date < today);
                return (
                  <tr key={h.date} className={past ? 'dim' : undefined}>
                    <td className="nowrap num">{day(h.date)}</td>
                    <td>{h.name}</td>
                    <td className="actions">
                      {past ? (
                        <span className="muted small" title={t('err.PAST_DATE_LOCKED')}>
                          🔒 {t('holidays.locked')}
                        </span>
                      ) : (
                        <>
                          <button type="button" className="btn small" onClick={() => { setFormError(null); setRenameText(h.name); setRenaming(h); }}>
                            {t('holidays.rename')}
                          </button>
                          <button type="button" className="btn small" onClick={() => { setFormError(null); setDeleting(h); }}>
                            {t('common.delete')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={!!renaming}
        title={renaming ? t('holidays.renameTitle', { date: day(renaming.date) }) : ''}
        onClose={() => setRenaming(null)}
        width={420}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="rename-holiday" className="btn primary" disabled={busy || !renameText.trim()}>
              {t('common.save')}
            </button>
          </>
        }
      >
        <form
          id="rename-holiday"
          onSubmit={async (e) => {
            e.preventDefault();
            if (renaming && (await perform({ kind: 'put', date: renaming.date, name: renameText.trim(), added: false }))) setRenaming(null);
          }}
        >
          <label className="field">
            <span>{t('holidays.name')}</span>
            <input value={renameText} onChange={(e) => setRenameText(e.target.value)} maxLength={60} />
          </label>
        </form>
        {formError && <div className="form-error">{formError}</div>}
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        title={t('holidays.deleteTitle')}
        confirmLabel={t('common.delete')}
        danger
        busy={busy}
        error={formError}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting && (await perform({ kind: 'delete', date: deleting.date, name: deleting.name }))) setDeleting(null);
        }}
      >
        <p style={{ margin: 0 }}>{deleting && t('holidays.deleteConfirm', { date: day(deleting.date, { year: true }), name: deleting.name })}</p>
      </ConfirmDialog>

      <Dialog
        open={!!conflict}
        title={t('holidays.conflictTitle')}
        onClose={() => setConflict(null)}
        width={500}
        footer={
          <button type="button" className="btn primary" onClick={() => setConflict(null)}>
            {t('common.close')}
          </button>
        }
      >
        <div>{t('err.HOLIDAY_CONFLICT')}</div>
        <div className="muted small">{t('holidays.conflictText')}</div>
        <ul className="list-plain">
          {(conflict?.details.routes ?? []).map((r) => (
            <li key={r.id} className="row">
              <RouteCode code={r.code} type={r.type} />
              <TypeTag type={r.type} />
              <span>{r.name}</span>
              <span className="muted">{day(r.date)}</span>
              <Link to={`/?view=week&anchor=${r.date}`} onClick={() => setConflict(null)}>
                {t('holidays.openCalendar')}
              </Link>
            </li>
          ))}
        </ul>
      </Dialog>

      <RunExistsDialog
        error={runErr?.error ?? null}
        busy={busy}
        onClose={() => setRunErr(null)}
        onRelease={async () => {
          const a = runErr?.action;
          setRunErr(null);
          if (a && (await perform(a, true))) {
            setRenaming(null);
            setDeleting(null);
            if (a.kind === 'put' && a.added) {
              setNewDate('');
              setNewName('');
            }
          }
        }}
      />
    </>
  );
}
