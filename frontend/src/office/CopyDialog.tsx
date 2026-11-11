// Copy to date (R15, §6.4) for a route occurrence, and Copy / Move this date (R19) for a task occurrence.
// Route: target date ≥ today; the resulting type and suggested code come from
// GET /api/routes/suggest-code?type=copy (called whenever the date changes): "Regular (only this date)" on a
// work day (Adhoc when the source is adhoc), "Special (only this date)" on a rest day. "Skip the original" is
// ticked by default when the source is a runnable recurring date. Modes: 'ph' = [Run on PH] (same date),
// 'move' = [Move to work day…] (default target: the first work day after the paused date, never today's
// next work day), 'copy' = free target. A route target where the same code already runs gets a warning.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  copyRouteDate,
  copyTaskDate,
  getRoute,
  getTask,
  isApiError,
  listHolidays,
  suggestRouteCode,
  type RouteOccurrence,
  type TaskOccurrence,
} from '../api';
import { fmtDay, useI18n } from '../i18n';
import { TypeTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useCalendar } from './calendarContext';
import { nextWorkDayAfter } from './calendarModel';
import { useGuardedWrite } from './officeShared';

export function CopyDialog({ occ, mode, onClose }: { occ: RouteOccurrence | TaskOccurrence; mode: 'copy' | 'ph' | 'move'; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { data } = useCalendar();
  const toast = useToast();
  const errText = useErrorText();
  const w = useGuardedWrite();
  const today = data.today;
  const isRoute = occ.kind === 'route';
  const runnable = occ.recurring && occ.status === 'scheduled' && occ.date >= today && !occ.frozen;
  // Move: the first work day after the paused date (holidays from the loaded range, refined by the list).
  const holQ = useQuery({ queryKey: ['holidays'], queryFn: () => listHolidays(), enabled: mode === 'move', retry: false });
  const holidays = useMemo(
    () => new Set([...data.days.filter((d) => d.holiday).map((d) => d.date), ...(holQ.data ?? []).map((h) => h.date)]),
    [data.days, holQ.data],
  );
  const moveDefault = mode === 'move' ? nextWorkDayAfter(occ.date, (d) => holidays.has(d), today) : '';
  const [to, setTo] = useState(() => (mode === 'ph' ? occ.date : mode === 'move' ? moveDefault : occ.date >= today ? '' : today));
  const [toTouched, setToTouched] = useState(false);
  useEffect(() => {
    if (mode === 'move' && !toTouched && moveDefault) setTo(moveDefault);
  }, [mode, toTouched, moveDefault]);
  const [skip, setSkip] = useState(runnable && mode !== 'ph');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState('');

  const suggestQ = useQuery({
    queryKey: ['suggest-code', 'copy', isRoute ? occ.route_id : 0, to],
    queryFn: () => suggestRouteCode({ type: 'copy', date: to, route_id: (occ as RouteOccurrence).route_id }),
    enabled: isRoute && /^\d{4}-\d{2}-\d{2}$/.test(to) && !occ.frozen,
    retry: false,
  });
  useEffect(() => {
    if (suggestQ.data && !codeTouched) setCode(suggestQ.data.code);
  }, [suggestQ.data, codeTouched]);
  const resType = suggestQ.data?.type;
  // The same route already runs on the target date (only dates in the loaded range are known).
  const alreadyRuns = isRoute && !!to && to !== occ.date && data.routes.some((o) => o.code === occ.code && o.date === to && o.status === 'scheduled');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to) return w.setError(t('err.required_field', { field: t('copy.to') }));
    await w.run(
      async (rel) => {
        // A past source is read from its frozen plan; its rev may be old: use the live rev when the item still exists.
        let rev: number | undefined = occ.rev;
        if (occ.frozen) {
          try {
            rev = isRoute ? (await getRoute(occ.route_id)).rev : (await getTask((occ as TaskOccurrence).task_id)).rev;
          } catch (err) {
            if (!isApiError(err, 'NOT_FOUND')) throw err;
            rev = undefined;
          }
        }
        const extra = { ...(skip ? { skip_source: true } : {}), ...(rel ? { release_run: true } : {}) };
        if (isRoute) {
          return (await copyRouteDate(occ.route_id, occ.date, { rev, to, ...(code.trim() ? { code: code.trim().toUpperCase() } : {}), ...(name.trim() ? { name: name.trim() } : {}), ...extra })).created.code;
        }
        await copyTaskDate((occ as TaskOccurrence).task_id, occ.date, { rev, to, ...extra });
        return fmtDay(to, lang);
      },
      (what) => {
        toast(t('copy.done', { what }));
        onClose();
      },
    );
  };

  const titleKey = mode === 'ph' ? 'copy.runOnPh' : mode === 'move' ? (isRoute ? 'copy.moveWorkDay' : 'copy.moveDate') : 'copy.title';
  const label = isRoute ? occ.code : `${occ.waste_type} ${data.customers[String(occ.customer_id)]?.name ?? ''}`;
  return (
    <>
      <Dialog
        open
        width={480}
        title={`${t(titleKey)} · ${label}`}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="copy-form" className="btn primary" disabled={w.busy}>
              {t('copy.submit')}
            </button>
          </>
        }
      >
        <form id="copy-form" className="stack" onSubmit={submit} noValidate>
          <div className="muted small">{t('copy.from', { date: fmtDay(occ.date, lang) })}</div>
          <label className="field">
            <span>{t('copy.to')}</span>
            <input
              type="date"
              value={to}
              min={today}
              disabled={mode === 'ph'}
              onChange={(e) => {
                setTo(e.target.value);
                setToTouched(true);
              }}
              data-autofocus
            />
            {to && <span className="hint">{fmtDay(to, lang)}</span>}
          </label>
          {isRoute && resType && (
            <div className="row">
              <TypeTag type={resType} />
              <span>{t(`copy.result.${resType}`)}</span>
              {suggestQ.data?.holiday && <span className="tag ph">{suggestQ.data.holiday}</span>}
            </div>
          )}
          {alreadyRuns && (
            <div className="banner warn" role="status" data-testid="copy-already-runs">
              {t('copy.alreadyRuns', { code: occ.code, date: fmtDay(to, lang) })}
            </div>
          )}
          {isRoute && suggestQ.error ? <div className="form-error">{errText(suggestQ.error)}</div> : null}
          {isRoute && (
            <div className="form-grid">
              <label className="field">
                <span>{t('common.code')}</span>
                <input
                  className="code"
                  value={code}
                  maxLength={8}
                  onChange={(e) => {
                    setCode(e.target.value.toUpperCase());
                    setCodeTouched(true);
                  }}
                />
              </label>
              <label className="field">
                <span>{t('common.name')}</span>
                <input value={name} maxLength={100} placeholder={t('copy.namePlaceholder', { name: occ.name, date: fmtDay(occ.date, 'en') })} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
          )}
          {runnable && (
            <label className="check">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> {t('copy.skipSource', { date: fmtDay(occ.date, lang) })}
            </label>
          )}
          {w.error && (
            <div className="form-error" role="alert">
              {w.error}
            </div>
          )}
        </form>
      </Dialog>
      {w.dialog}
    </>
  );
}

/** "End from date D": the item no longer runs from D (end = D − 1). */
export function EndDialog(props: { title: string; initial: string; min: string; busy?: boolean; error?: string | null; onSubmit: (from: string) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [from, setFrom] = useState(props.initial);
  return (
    <Dialog
      open
      width={420}
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn danger" disabled={props.busy || !from} onClick={() => props.onSubmit(from)}>
            {t('end.submit')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('end.from')}</span>
        <input type="date" value={from} min={props.min} onChange={(e) => setFrom(e.target.value)} data-autofocus />
        {from && <span className="hint">{t('end.hint', { date: fmtDay(from, lang) })}</span>}
      </label>
      {props.error && (
        <div className="form-error" role="alert">
          {props.error}
        </div>
      )}
    </Dialog>
  );
}
