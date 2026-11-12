// Urgent pickup (§6.7): "phone call today, tomorrow go to A and B" in about 4 interactions.
// - Date chips: [Today] [Next work day] (default, from /api/meta) [Pick…]. Whenever the date changes,
//   GET /api/routes/suggest-code?type=adhoc&date=… gives the code, the day class and the resulting type.
// - The waste type the pickup collects (REL or Recycling: a route collects one type), then a multi-add
//   picker of the customers registered with it, with quick-create.
// - Target: (•) New one-off (on a rest date the label visibly switches to "Special, only this date" with the
//   reason; never silently) or ( ) Add to an existing route of that type on that date (an "only this date" edit).
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createRoute, getCalendar, putRouteDate, suggestRouteCode, type RouteOccurrence } from '../api';
import { fmtDay, useI18n } from '../i18n';
import { useSession } from '../session';
import { TypeTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useCalendar } from './calendarContext';
import { routesByCustomer } from './calendarModel';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { useGuardedWrite } from './officeShared';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function UrgentDialog(props: { initialDate?: string; initialCustomers?: number[]; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { data } = useCalendar();
  const toast = useToast();
  const errText = useErrorText();
  const w = useGuardedWrite();
  const today = data.today;
  const [mode, setMode] = useState<'today' | 'next' | 'pick'>(props.initialDate ? 'pick' : 'next');
  const [picked, setPicked] = useState(props.initialDate ?? '');
  const date = mode === 'today' ? today : mode === 'next' ? meta?.next_work_day ?? '' : picked;
  const valid = DATE_RE.test(date) && date >= today;

  const [customers, setCustomers] = useState<PickedCustomer[]>(() =>
    (props.initialCustomers ?? []).map((id) => {
      const c = data.customers[String(id)];
      return c ?? { id, code: '', name: `#${id}`, address: '', waste_types: [], active: true };
    }),
  );
  // One route collects one waste type: picked first, it limits the customers and the existing routes offered.
  const routable = (meta?.waste_types ?? []).filter((x) => x.routable && x.active);
  const [wasteTypeSel, setWasteType] = useState('');
  const wasteType = wasteTypeSel || routable[0]?.code || 'REL';
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [routeKey, setRouteKey] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [note, setNote] = useState('');

  const suggestQ = useQuery({
    queryKey: ['suggest-code', 'adhoc', date],
    queryFn: () => suggestRouteCode({ type: 'adhoc', date }),
    enabled: valid,
    retry: false,
  });
  const sug = suggestQ.data;
  useEffect(() => {
    if (sug && !codeTouched) setCode(sug.code);
    if (sug && !nameTouched) setName(t(sug.type === 'special' ? 'rf.specialName' : 'rf.adhocName', { date: fmtDay(date, 'en', { weekday: false }) }));
  }, [sug, codeTouched, nameTouched]); // eslint-disable-line react-hooks/exhaustive-deps

  // Routes running on that date (for "add to an existing route" and the picker's "also on").
  const dayQ = useQuery({ queryKey: ['calendar', 'week', date], queryFn: () => getCalendar('week', date), enabled: valid });
  const dayRoutes: RouteOccurrence[] = useMemo(
    () => (dayQ.data?.routes ?? []).filter((o) => o.date === date && o.status === 'scheduled' && !o.frozen && o.waste_type === wasteType),
    [dayQ.data, date, wasteType],
  );
  const alsoOn = useMemo(() => routesByCustomer(dayRoutes), [dayRoutes]);
  useEffect(() => {
    if (routeKey && !dayRoutes.some((o) => o.key === routeKey)) setRouteKey('');
  }, [dayRoutes, routeKey]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    w.setError(null);
    if (!valid) return w.setError(t('urgent.needDate'));
    if (customers.length === 0) return w.setError(t('urgent.needCustomers'));
    const stops = customers.map((c) => ({ customer_id: c.id, note: '' }));
    if (target === 'new') {
      if (!sug) return;
      await w.run(
        () => createRoute({ type: sug.type === 'special' ? 'special' : 'adhoc', waste_type: wasteType, code: code.trim().toUpperCase(), name: name.trim(), note: note.trim(), date, stops }),
        (r) => {
          toast(t('urgent.created', { code: r.data.code, date: fmtDay(date, lang) }));
          props.onClose();
        },
      );
      return;
    }
    const occ = dayRoutes.find((o) => o.key === routeKey);
    if (!occ) return w.setError(t('urgent.needRoute'));
    const have = new Set(occ.stops.map((s) => s.customer_id));
    const merged = [...occ.stops.map((s) => ({ customer_id: s.customer_id, note: s.note })), ...stops.filter((s) => !have.has(s.customer_id))];
    await w.run(
      (rel) => putRouteDate(occ.route_id, date, { rev: occ.rev, scope: 'this', stops: merged, ...(rel ? { release_run: true } : {}) }),
      () => {
        toast(t('urgent.added', { n: merged.length - occ.stops.length, code: occ.code, date: fmtDay(date, lang) }));
        props.onClose();
      },
    );
  };

  const rest = sug?.class === 'rest';
  return (
    <>
      <Dialog
        open
        width={600}
        title={`⚡ ${t('urgent.title')}`}
        onClose={props.onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="urgent-form" className="btn primary" disabled={w.busy || !valid}>
              {target === 'new' ? t('urgent.createBtn') : t('urgent.addBtn')}
            </button>
          </>
        }
      >
        <form id="urgent-form" className="stack" onSubmit={submit} noValidate>
          <div className="field">
            <span>{t('common.date')}</span>
            <div className="row">
              <div className="seg" role="group" aria-label={t('common.date')}>
                <button type="button" aria-pressed={mode === 'today'} onClick={() => setMode('today')}>
                  {t('common.today')}
                </button>
                <button type="button" aria-pressed={mode === 'next'} onClick={() => setMode('next')}>
                  {t('urgent.nextWorkDay')}
                </button>
                <button type="button" aria-pressed={mode === 'pick'} onClick={() => setMode('pick')}>
                  {t('urgent.pick')}
                </button>
              </div>
              {mode === 'pick' && <input type="date" className="input" style={{ width: 170 }} min={today} value={picked} onChange={(e) => setPicked(e.target.value)} aria-label={t('urgent.pick')} />}
              {valid && <strong>{fmtDay(date, lang)}</strong>}
              {sug?.holiday && <span className="tag ph">{sug.holiday}</span>}
            </div>
          </div>

          <label className="field">
            <span>{t('rf.wasteType')}</span>
            <select
              className="input"
              style={{ width: 'auto' }}
              value={wasteType}
              data-testid="urgent-waste-type"
              onChange={(e) => {
                setWasteType(e.target.value);
                setCustomers([]); // the picked customers were registered with the other type
              }}
            >
              {routable.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>{t('urgent.customers')}</span>
            {customers.length > 0 && (
              <div className="picked">
                {customers.map((c) => (
                  <span key={c.id} className="chip" aria-pressed="false">
                    {c.name}
                    <button type="button" className="linkbtn" aria-label={`${t('stops.remove')} ${c.name}`} onClick={() => setCustomers((s) => s.filter((x) => x.id !== c.id))}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <CustomerPicker
              autoFocus
              wasteType={wasteType}
              excludeIds={customers.map((c) => c.id)}
              alsoOn={alsoOn}
              onPick={(c) => setCustomers((s) => (s.some((x) => x.id === c.id) ? s : [...s, c]))}
            />
          </div>

          <div className="radio-list" role="radiogroup" aria-label={t('urgent.target')}>
            <label>
              <input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />
              {sug ? <TypeTag type={sug.type} /> : null}
              <span>{rest ? t('urgent.newSpecial') : t('urgent.newAdhoc')}</span>
            </label>
            {rest && target === 'new' && <div className="banner warn small">{t('urgent.restReason')}</div>}
            {target === 'new' && (
              <div className="form-grid" style={{ marginLeft: 24 }}>
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
                  <input
                    value={name}
                    maxLength={100}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(true);
                    }}
                  />
                </label>
                <label className="field full">
                  <span>{t('urgent.note')}</span>
                  <input value={note} maxLength={500} placeholder={t('rf.adhocNotePlaceholder')} onChange={(e) => setNote(e.target.value)} />
                </label>
              </div>
            )}
            <label>
              <input type="radio" checked={target === 'existing'} disabled={dayRoutes.length === 0} onChange={() => setTarget('existing')} />
              <span>{t('urgent.existing', { n: dayRoutes.length })}</span>
            </label>
            {target === 'existing' && (
              <select className="input" style={{ marginLeft: 24, width: 'auto' }} value={routeKey} onChange={(e) => setRouteKey(e.target.value)} aria-label={t('urgent.existingPick')}>
                <option value="">{t('urgent.existingPick')}</option>
                {dayRoutes.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.code} · {o.name} ({t('cal.nStops', { n: o.stops.length })}
                    {o.run?.driver ? ` · ${o.run.driver.name}` : ''})
                  </option>
                ))}
              </select>
            )}
            {target === 'existing' && routeKey && dayRoutes.find((o) => o.key === routeKey)?.date === today && <div className="muted small">{t('urgent.liveHint')}</div>}
          </div>
          {suggestQ.error ? <div className="form-error">{errText(suggestQ.error)}</div> : null}
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
