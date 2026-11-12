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
// A split route (R12 / R14) is edited as one route: Start and End are the whole route's (routeFormModel).
// R20: the form keeps the version it was loaded from and sends only the fields the clerk changed, with that
// version's rev. When someone else saves meanwhile, the fields the clerk did not touch take their values
// (and a banner names them); the first Save is answered with STALE_REVISION, the second one saves the
// clerk's own changes on top of theirs (K4, SPLIT-UI-11).
// Round 6: on a split route, a later part that has a schedule of its own keeps it; only the weekdays (or
// Sunday / PH) the clerk adds or removes reach it. Before the save the form names each such part and what it
// will run, computed with the server's rule (routeCarry) from the writes the form would send, live while the
// clerk ticks weekdays or picks the date. The first write sends the parts those notices were computed on, so
// the save is refused (STALE_REVISION) when another clerk changed one of them meanwhile, and the notices are
// recomputed on the parts loaded after that answer.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeRouteSchedule,
  createRoute,
  getRoute,
  isApiError,
  listRoutes,
  patchRoute,
  suggestRouteCode,
  type Route,
  type RouteCreate,
  type RoutePart,
} from '../api';
import { fmtDay, useI18n, weekdayName, weekdayOf } from '../i18n';
import { useSession } from '../session';
import { Chip, TypeTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { Loading } from '../ui/Feedback';
import { COLOR_INDEXES, rcStyle } from '../ui/palette';
import { useToast } from '../ui/Toast';
import type { CreateKind } from './calendarContext';
import { addDays } from './calendarModel';
import { useGuardedWrite } from './officeShared';
import { afterPatch, afterSplit, keptSchedules, keptScheduleText, partsRev } from './routeCarry';
import { useAllRoutes } from './routeChain';
import { afterStep, mergeServer, planEdit, snapOf, type Field, type FormVals, type Snap } from './routeFormModel';

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

  const today = useSession().meta?.today ?? '';
  const allQ = useAllRoutes(edit);
  // The server's version (the whole route for a split one), once both queries have answered.
  const ready = !!route && (allQ.isSuccess || allQ.isError);
  const server = useMemo(() => (ready && route ? snapOf(route, allQ.data, today) : null), [ready, route, allQ.data, today]);
  const serverSig = server ? JSON.stringify(server) : '';

  const [form, setForm] = useState<{ vals: FormVals; base: Snap | null; theirs: Field[] }>({
    vals: { code: '', color: null, name: '', note: '', days: [], sun: true, ph: true, start: '', end: '', date: '' },
    base: null,
    theirs: [],
  });
  const { vals } = form;
  const set = <K extends Field>(k: K, v: FormVals[K]) => setForm((f) => ({ ...f, vals: { ...f.vals, [k]: v } }));
  const { code, color, name, note, days, sun, ph, start, end, date } = vals;
  const [codeTouched, setCodeTouched] = useState(false);
  const [apply, setApply] = useState<'today' | 'from'>(edit && props.fromD ? 'from' : 'today');
  const [fromDate, setFromDate] = useState(edit && props.date ? props.date : '');
  const loaded = edit ? !!form.base : form.vals.start !== '' || form.vals.date !== '';

  /** A server version arrived: load it, or merge it into the edits (R20). */
  const takeServer = (s: Snap, afterStale: boolean) =>
    setForm((f) => {
      if (!f.base) return { vals: s.vals, base: s, theirs: [] };
      const m = mergeServer(f.vals, f.base, s, afterStale);
      return { vals: m.vals, base: m.base, theirs: [...new Set([...f.theirs, ...m.theirs])] };
    });

  // Initial values.
  useEffect(() => {
    if (props.mode === 'create') {
      const v: Partial<FormVals> = { date: props.date, start: props.date };
      if (props.createType === 'regular') v.days = props.dow >= 1 && props.dow <= 6 ? [props.dow] : [];
      if (props.createType === 'adhoc') v.name = t('rf.adhocName', { date: fmtDay(props.date, 'en', { weekday: false }) });
      if (props.createType === 'special_once') v.name = t('rf.specialName', { date: fmtDay(props.date, 'en', { weekday: false }) });
      setForm((f) => ({ ...f, vals: { ...f.vals, ...v } }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (edit && server) takeServer(server, false);
  }, [serverSig]); // eslint-disable-line react-hooks/exhaustive-deps

  /** On STALE_REVISION the latest version is loaded and merged; the next Save sends only the clerk's changes.
   *  The route query takes that version too, so the notices and the parts the next Save sends are its own. */
  const qc = useQueryClient();
  const staleGuard =
    <R,>(fn: (rel: boolean) => Promise<R>) =>
    async (rel: boolean): Promise<R> => {
      try {
        return await fn(rel);
      } catch (e) {
        if (isApiError(e, 'STALE_REVISION') && props.mode === 'edit') {
          try {
            const [r, all] = await Promise.all([getRoute(props.routeId), listRoutes({ ended: true })]);
            qc.setQueryData(['route', props.routeId], r);
            takeServer(snapOf(r, all, today), true);
          } catch {
            /* the refetch after the error shows the latest version */
          }
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
    if (suggestQ.data && !codeTouched) set('code', suggestQ.data.code);
  }, [suggestQ.data, codeTouched]);

  const first = useMemo(() => (type === 'regular' && !oneOff ? firstRun(start, days) : null), [type, oneOff, start, days]);

  // The other parts of a split route with a schedule of their own, and what each runs after this save.
  const kept = useMemo(() => {
    const parts = route?.parts;
    if (!route || !form.base?.linked || oneOff || !parts || parts.length < 2 || (apply === 'from' && !fromDate)) return [];
    let after: RoutePart[] | null = parts;
    for (const s of planEdit(vals, form.base, { type: route.type, oneOff, apply, fromDate })) {
      if (after) after = s.kind === 'patch' ? afterPatch(after, s.id, s.body) : afterSplit(after, s.body, today);
    }
    return keptSchedules(parts, after, route.id, apply === 'from' ? fromDate : null);
  }, [route, form.base, oneOff, apply, fromDate, vals, today]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    w.setError(null);
    if (!code.trim()) return w.setError(t('err.required_field', { field: t('common.code') }));
    if (!name.trim()) return w.setError(t('err.required_field', { field: t('common.name') }));
    if (type === 'regular' && !oneOff && days.length === 0) return w.setError(t('rf.needDays'));
    if (type === 'special' && !oneOff && !sun && !ph) return w.setError(t('rf.needSunPh'));
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
    if (!route || !form.base) return;
    if (apply === 'from' && !oneOff && !fromDate) return w.setError(t('err.required_field', { field: t('rf.fromDate') }));
    const steps = planEdit(vals, form.base, { type: route.type, oneOff, apply, fromDate });
    // The parts the notices above were computed on (the first write checks them; the later ones follow it).
    const parts = partsRev(route.parts);
    const done = () => {
      toast(t('common.saved'));
      props.onSaved?.();
      props.onClose();
    };
    if (!steps.length) return done();
    // A retry after RUN_EXISTS (release_run) resumes after the writes that already went through.
    const progress = { done: 0, rev: new Map<number, number>() };
    await w.run(
      staleGuard(async (rel) => {
        for (let i = progress.done; i < steps.length; i++) {
          const s = steps[i];
          const extra = { rev: progress.rev.get(s.id) ?? s.body.rev, ...(i === 0 && parts ? { parts } : {}), ...(rel ? { release_run: true } : {}) };
          const rev = s.kind === 'patch' ? (await patchRoute(s.id, { ...s.body, ...extra })).data.rev : (await changeRouteSchedule(s.id, { ...s.body, ...extra })).data.ended.rev;
          progress.rev.set(s.id, rev);
          progress.done = i + 1;
          setForm((f) => (f.base ? { ...f, base: afterStep(f.base, f.vals, s, rev) } : f));
        }
      }),
      done,
    );
  };

  const fieldLabel = (k: Field) =>
    ({ code: t('common.code'), color: t('rf.color'), name: t('common.name'), note: t('common.note'), days: t('rf.days'), sun: t('rf.when'), ph: t('rf.when'), start: t('rf.start'), end: t('rf.end'), date: t('common.date') })[k];
  const theirs = [...new Set(form.theirs.map(fieldLabel))];

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
            {theirs.length > 0 && (
              <div className="full banner warn" role="status" data-testid="changed-meanwhile">
                {t('rf.theyChanged', { fields: theirs.join(', ') })}
              </div>
            )}
            <label className="field">
              <span>{t('common.code')}</span>
              <input
                className="code"
                value={code}
                maxLength={8}
                spellCheck={false}
                data-autofocus
                onChange={(e) => {
                  set('code', e.target.value.toUpperCase());
                  setCodeTouched(true);
                }}
              />
              {!edit && !oneOff && <span className="hint">{t('rf.codeHint')}</span>}
            </label>
            <label className="field">
              <span>{t('common.name')}</span>
              <input value={name} maxLength={100} onChange={(e) => set('name', e.target.value)} />
            </label>
            <div className="field full">
              <span>{t('rf.color')}</span>
              <div className="swatches" role="group" aria-label={t('rf.color')}>
                {!edit && (
                  <button type="button" className="auto" aria-pressed={color === null} onClick={() => set('color', null)}>
                    {t('rf.autoColor')}
                  </button>
                )}
                {COLOR_INDEXES.map((i) => (
                  <button key={i} type="button" style={rcStyle(i)} aria-pressed={color === i} aria-label={t('rf.colorN', { n: i })} onClick={() => set('color', i)} />
                ))}
              </div>
            </div>

            {oneOff ? (
              <label className="field">
                <span>{edit ? t('rf.changeDate') : t('common.date')}</span>
                <input type="date" value={date} disabled={!edit} onChange={(e) => set('date', e.target.value)} />
                <span className="hint">{fmtDay(date, lang)}</span>
              </label>
            ) : (
              <>
                {type === 'regular' ? (
                  <div className="field full">
                    <span>{t('rf.days')}</span>
                    <div className="chips" role="group" aria-label={t('rf.days')}>
                      {[1, 2, 3, 4, 5, 6].map((d) => (
                        <Chip key={d} pressed={days.includes(d)} onClick={() => set('days', days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
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
                        <input type="checkbox" checked={sun} onChange={(e) => set('sun', e.target.checked)} /> {t('rule.everySun')}
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={ph} onChange={(e) => set('ph', e.target.checked)} /> {t('rule.everyPh')}
                      </label>
                    </div>
                  </div>
                )}
                <label className="field">
                  <span>{t('rf.start')}</span>
                  <input type="date" value={start} disabled={edit && apply === 'from'} onChange={(e) => set('start', e.target.value)} />
                </label>
                <label className="field">
                  <span>
                    {t('rf.end')} ({t('common.optional')})
                  </span>
                  <input type="date" value={end} onChange={(e) => set('end', e.target.value)} />
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
                    {kept.map((k) => (
                      <div key={`${k.part.id}-${k.replacedFrom ?? ''}`} className="banner info" data-testid="kept-plan">
                        {keptScheduleText(k, today, t, lang)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <label className="field full">
              <span>{t('common.note')}</span>
              <textarea value={note} maxLength={500} onChange={(e) => set('note', e.target.value)} placeholder={type === 'adhoc' ? t('rf.adhocNotePlaceholder') : ''} />
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
