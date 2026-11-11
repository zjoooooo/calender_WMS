// Route create (one form per type, §6.6) and Edit route / schedule (§6.5).
// Create, offered only for the clicked day's can_create:
//   - Regular · repeats weekly: Mon–Sat chips (the clicked weekday pre-ticked), start = clicked date,
//     optional end, "First run: Wed 18 Nov";
//   - Special · every Sunday / PH: Every Sunday / Every PH, start, end;
//   - Special · this date only and ⚡ Adhoc · this date only: the date, code from suggest-code (A<n> / S<n>),
//     name "Adhoc 12 Nov", note (caller and reason).
// Edit: code, colour (10 swatches), name, note, Mon–Sat or Sunday/PH, start and end; one-offs: the date
// (Change date, re-checked by R6). Schedule changes apply (•) from today (template edit) or ( ) from date D
// (R14 change-schedule; code, colour, name and note always apply at once).
// R20: an edit sends the rev the form was loaded from (not the refetched one), so a change saved by someone
// else meanwhile is answered with STALE_REVISION; the form keeps its values and a second save replaces it.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  changeRouteSchedule,
  createRoute,
  getRoute,
  isApiError,
  patchRoute,
  suggestRouteCode,
  type Route,
  type RouteCreate,
  type RoutePatch,
} from '../api';
import { fmtDay, useI18n, weekdayName, weekdayOf } from '../i18n';
import { Chip, TypeTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { Loading } from '../ui/Feedback';
import { COLOR_INDEXES, rcStyle } from '../ui/palette';
import { useToast } from '../ui/Toast';
import type { CreateKind } from './calendarContext';
import { addDays } from './calendarModel';
import { useGuardedWrite } from './officeShared';

type Props =
  | { mode: 'create'; createType: CreateKind; date: string; dow: number; onClose: () => void; onCreated: (r: Route, openDate: string | null) => void }
  | { mode: 'edit'; routeId: number; date?: string; fromD?: boolean; onClose: () => void; onSaved?: () => void };

/** First date >= start whose weekday is in days (display hint only; holidays are not considered). */
function firstRun(start: string, days: number[]): string | null {
  if (!start || !days.length) return null;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (days.includes(weekdayOf(d))) return d;
  }
  return null;
}

export function RouteForm(props: Props) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const w = useGuardedWrite();
  const edit = props.mode === 'edit';
  const routeQ = useQuery({ queryKey: ['route', edit ? props.routeId : 0], queryFn: () => getRoute((props as { routeId: number }).routeId), enabled: edit });
  const route = routeQ.data;

  const createType = props.mode === 'create' ? props.createType : null;
  const type = edit ? route?.type : createType === 'adhoc' ? 'adhoc' : createType === 'regular' ? 'regular' : 'special';
  const oneOff = edit ? !!route && !route.recurring && !!route.date : createType === 'adhoc' || createType === 'special_once';

  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [color, setColor] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [sun, setSun] = useState(true);
  const [ph, setPh] = useState(true);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [date, setDate] = useState('');
  const [apply, setApply] = useState<'today' | 'from'>(edit && props.fromD ? 'from' : 'today');
  const [fromDate, setFromDate] = useState(edit && props.date ? props.date : '');
  const [loaded, setLoaded] = useState(false);
  const [baseRev, setBaseRev] = useState<number | null>(null);

  // Initial values.
  useEffect(() => {
    if (props.mode === 'create') {
      setDate(props.date);
      setStart(props.date);
      if (props.createType === 'regular') setDays(props.dow >= 1 && props.dow <= 6 ? [props.dow] : []);
      if (props.createType === 'adhoc') setName(t('rf.adhocName', { date: fmtDay(props.date, 'en', { weekday: false }) }));
      if (props.createType === 'special_once') setName(t('rf.specialName', { date: fmtDay(props.date, 'en', { weekday: false }) }));
      setLoaded(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!edit || !route || loaded) return;
    setCode(route.code);
    setColor(route.color);
    setName(route.name);
    setNote(route.note);
    setDays(route.days ?? []);
    setSun(!!route.sun);
    setPh(!!route.ph);
    setStart(route.start ?? '');
    setEnd(route.end ?? '');
    setDate(route.date ?? '');
    setBaseRev(route.rev);
    setLoaded(true);
  }, [edit, route, loaded]);
  /** After STALE_REVISION (shown, refetched) the next save is based on the current rev. */
  const staleGuard =
    <R,>(fn: (rel: boolean) => Promise<R>) =>
    async (rel: boolean): Promise<R> => {
      try {
        return await fn(rel);
      } catch (e) {
        if (isApiError(e, 'STALE_REVISION')) {
          const current = Number((e.details as { current?: unknown } | null)?.current);
          if (Number.isFinite(current) && current > 0) setBaseRev(current);
        }
        throw e;
      }
    };

  // Suggested code for a new one-off (A<n> on a work day, S<n> on a rest day).
  const suggestQ = useQuery({
    queryKey: ['suggest-code', createType, date],
    queryFn: () => suggestRouteCode({ type: createType === 'adhoc' ? 'adhoc' : 'special', date }),
    enabled: !edit && oneOff && !!date,
  });
  useEffect(() => {
    if (suggestQ.data && !codeTouched) setCode(suggestQ.data.code);
  }, [suggestQ.data, codeTouched]);

  const first = useMemo(() => (type === 'regular' && !oneOff ? firstRun(start, days) : null), [type, oneOff, start, days]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    w.setError(null);
    if (!code.trim()) return w.setError(t('err.required_field', { field: t('common.code') }));
    if (!name.trim()) return w.setError(t('err.required_field', { field: t('common.name') }));
    if (type === 'regular' && !oneOff && days.length === 0) return w.setError(t('rf.needDays'));
    if (type === 'special' && !oneOff && !sun && !ph) return w.setError(t('rf.needSunPh'));
    const sched = type === 'regular' ? { days: [...days].sort() } : { sun, ph };
    if (props.mode === 'create') {
      const base = { code: code.trim().toUpperCase(), color, name: name.trim(), note: note.trim(), stops: [] };
      const body: RouteCreate = oneOff
        ? { ...base, type: createType === 'adhoc' ? 'adhoc' : 'special', date }
        : type === 'regular'
          ? { ...base, type: 'regular', start, end: end || null, days: [...days].sort() }
          : { ...base, type: 'special', start, end: end || null, sun, ph };
      await w.run(
        () => createRoute(body),
        (r) => {
          toast(t('rf.created', { code: r.data.code }));
          props.onCreated(r.data, oneOff || type !== 'regular' || days.includes(props.dow) ? props.date : null);
        },
      );
      return;
    }
    if (!route) return;
    const ident: RoutePatch = { rev: baseRev ?? route.rev };
    if (code.trim().toUpperCase() !== route.code) ident.code = code.trim().toUpperCase();
    if (color !== null && color !== route.color) ident.color = color;
    if (name.trim() !== route.name) ident.name = name.trim();
    if (note.trim() !== route.note) ident.note = note.trim();
    const done = () => {
      toast(t('common.saved'));
      props.onSaved?.();
      props.onClose();
    };
    if (oneOff) {
      if (date !== route.date) ident.date = date;
      await w.run(staleGuard((rel) => patchRoute(route.id, { ...ident, ...(rel ? { release_run: true } : {}) })), done);
      return;
    }
    if (apply === 'today') {
      const body: RoutePatch = { ...ident, ...sched };
      if (start !== (route.start ?? '')) body.start = start;
      if ((end || null) !== (route.end ?? null)) body.end = end || null;
      await w.run(staleGuard((rel) => patchRoute(route.id, { ...body, ...(rel ? { release_run: true } : {}) })), done);
      return;
    }
    // From date D: identity first (template edit), then the schedule split (R14).
    if (!fromDate) return w.setError(t('err.required_field', { field: t('rf.fromDate') }));
    await w.run(staleGuard(async (rel) => {
      let rev = ident.rev;
      if (Object.keys(ident).length > 1) rev = (await patchRoute(route.id, ident)).data.rev;
      const cs = await changeRouteSchedule(route.id, { rev, from: fromDate, ...sched, end: end || null, ...(rel ? { release_run: true } : {}) });
      return cs;
    }), done);
  };

  const titleKey = edit ? 'rf.editTitle' : `rf.create.${createType}`;
  const cur = edit ? route : null;
  return (
    <>
      <Dialog
        open
        width={560}
        title={
          <span className="row" style={{ gap: 8 }}>
            {type && <TypeTag type={type} />}
            {t(titleKey, { code: cur?.code ?? '' })}
          </span>
        }
        onClose={props.onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="route-form" className="btn primary" disabled={w.busy || !loaded}>
              {edit ? t('common.save') : t('common.create')}
            </button>
          </>
        }
      >
        {edit && routeQ.isLoading && <Loading />}
        {loaded && (
          <form id="route-form" className="form-grid" onSubmit={submit} noValidate>
            <label className="field">
              <span>{t('common.code')}</span>
              <input
                className="code"
                value={code}
                maxLength={8}
                spellCheck={false}
                data-autofocus
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setCodeTouched(true);
                }}
              />
              {!edit && !oneOff && <span className="hint">{t('rf.codeHint')}</span>}
            </label>
            <label className="field">
              <span>{t('common.name')}</span>
              <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="field full">
              <span>{t('rf.color')}</span>
              <div className="swatches" role="group" aria-label={t('rf.color')}>
                {!edit && (
                  <button type="button" className="auto" aria-pressed={color === null} onClick={() => setColor(null)}>
                    {t('rf.autoColor')}
                  </button>
                )}
                {COLOR_INDEXES.map((i) => (
                  <button key={i} type="button" style={rcStyle(i)} aria-pressed={color === i} aria-label={t('rf.colorN', { n: i })} onClick={() => setColor(i)} />
                ))}
              </div>
            </div>

            {oneOff ? (
              <label className="field">
                <span>{edit ? t('rf.changeDate') : t('common.date')}</span>
                <input type="date" value={date} disabled={!edit} onChange={(e) => setDate(e.target.value)} />
                <span className="hint">{fmtDay(date, lang)}</span>
              </label>
            ) : (
              <>
                {type === 'regular' ? (
                  <div className="field full">
                    <span>{t('rf.days')}</span>
                    <div className="chips" role="group" aria-label={t('rf.days')}>
                      {[1, 2, 3, 4, 5, 6].map((d) => (
                        <Chip key={d} pressed={days.includes(d)} onClick={() => setDays((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))}>
                          {weekdayName(d, lang)}
                        </Chip>
                      ))}
                    </div>
                    {first && !edit && <span className="hint">{t('rf.firstRun', { date: fmtDay(first, lang) })}</span>}
                  </div>
                ) : (
                  <div className="field full">
                    <span>{t('rf.when')}</span>
                    <div className="row">
                      <label className="check">
                        <input type="checkbox" checked={sun} onChange={(e) => setSun(e.target.checked)} /> {t('rule.everySun')}
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={ph} onChange={(e) => setPh(e.target.checked)} /> {t('rule.everyPh')}
                      </label>
                    </div>
                  </div>
                )}
                <label className="field">
                  <span>{t('rf.start')}</span>
                  <input type="date" value={start} disabled={edit && apply === 'from'} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="field">
                  <span>
                    {t('rf.end')} ({t('common.optional')})
                  </span>
                  <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
                {edit && (
                  <div className="field full">
                    <span>{t('rf.apply')}</span>
                    <div className="radio-list">
                      <label>
                        <input type="radio" checked={apply === 'today'} onChange={() => setApply('today')} /> {t('rf.applyToday')}
                      </label>
                      <label>
                        <input type="radio" checked={apply === 'from'} onChange={() => setApply('from')} /> {t('rf.applyFrom')}
                        <input type="date" className="input" style={{ width: 170 }} value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label={t('rf.fromDate')} />
                      </label>
                    </div>
                    {apply === 'from' && <span className="hint">{t('rf.applyFromHint')}</span>}
                  </div>
                )}
              </>
            )}
            <label className="field full">
              <span>{t('common.note')}</span>
              <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={type === 'adhoc' ? t('rf.adhocNotePlaceholder') : ''} />
            </label>
            {!edit && <div className="full note">{t('rf.afterCreate')}</div>}
            {w.error && (
              <div className="full form-error" role="alert">
                {w.error}
              </div>
            )}
          </form>
        )}
      </Dialog>
      {w.dialog}
    </>
  );
}
