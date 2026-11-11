// Routes page (§9.2): table (colour, code, type, name, schedule, start/end, stops, next date, today's
// status) with a filter that shows ended routes; the template editor (the same StopList as the route drawer:
// drag and drop, ↑ ↓, move to #); actions [Edit route…], [Change schedule from date…], [End], [Delete].
// A template save applies from today (PATCH stops) or from a later date D (change-schedule with stops, R14).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  changeRouteSchedule,
  deleteRoute,
  getRoute,
  listCustomers,
  listRoutes,
  patchRoute,
  type RouteListItem,
  type Stop,
} from '../api';
import { fmtDay, useI18n, weekdayOf } from '../i18n';
import { useSession } from '../session';
import { TypeTag } from '../ui/Chip';
import { ConfirmDialog } from '../ui/Dialog';
import { Drawer } from '../ui/Drawer';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { rcStyle } from '../ui/palette';
import { useToast } from '../ui/Toast';
import type { CreateKind } from './calendarContext';
import { addDays } from './calendarModel';
import { EndDialog } from './CopyDialog';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { MenuButton, routeRuleText, useGuardedWrite } from './officeShared';
import { RouteForm } from './RouteForm';
import { StopList } from './StopList';
import { addStop, draftFrom, isDirty, removeStop, restoreStop, setStopNote } from './stopDraft';
import './office.css';

type Dlg =
  | { kind: 'create'; type: CreateKind }
  | { kind: 'edit'; id: number; fromD?: boolean }
  | { kind: 'end'; r: RouteListItem }
  | { kind: 'delete'; r: RouteListItem }
  | { kind: 'template'; id: number };

export default function RoutesPage() {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const toast = useToast();
  const w = useGuardedWrite();
  const [ended, setEnded] = useState(false);
  const [filter, setFilter] = useState('');
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const q = useQuery({ queryKey: ['routes', { ended }], queryFn: () => listRoutes({ ended }) });
  const today = meta?.today ?? '';
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((r) => !f || r.code.toLowerCase().includes(f) || r.name.toLowerCase().includes(f));
  }, [q.data, filter]);

  const status = (r: RouteListItem) => (r.today_status ? t(`status.${r.today_status}`) : '–');
  return (
    <>
      <div className="page-head">
        <h1>{t('nav.routes')}</h1>
        <input className="search" type="search" value={filter} placeholder={t('routes.filter')} onChange={(e) => setFilter(e.target.value)} aria-label={t('common.search')} />
        <label className="check">
          <input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} /> {t('routes.showEnded')}
        </label>
        <span className="spacer" />
        <MenuButton
          className="btn primary"
          label={`+ ${t('routes.new')}`}
          items={[
            { label: t('cal.addRegular'), onClick: () => setDlg({ kind: 'create', type: 'regular' }) },
            { label: t('cal.addSpecial'), onClick: () => setDlg({ kind: 'create', type: 'special' }) },
          ]}
        />
      </div>
      <div className="muted small">{t('routes.hint')}</div>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {w.error && <div className="form-error">{w.error}</div>}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('routes.colCode')}</th>
                <th>{t('routes.colType')}</th>
                <th>{t('common.name')}</th>
                <th>{t('routes.colSchedule')}</th>
                <th>{t('routes.colPeriod')}</th>
                <th>{t('routes.colStops')}</th>
                <th>{t('routes.colNext')}</th>
                <th>{t('routes.colToday')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.ended ? 'dim clickable' : 'clickable'} onClick={() => setDlg({ kind: 'template', id: r.id })}>
                  <td>
                    <span className="rcode code" style={rcStyle(r.color)}>
                      {r.type === 'adhoc' ? '⚡' : ''}
                      {r.code}
                    </span>
                  </td>
                  <td>
                    <TypeTag type={r.type} />
                  </td>
                  <td>{r.name}</td>
                  <td className="small">{routeRuleText({ ...r, recurring: r.recurring ?? !r.date }, t, lang).split(' · ').slice(1).join(' · ')}</td>
                  <td className="small nowrap">
                    {r.date ? fmtDay(r.date, lang) : `${fmtDay(r.start ?? '', lang, { weekday: false })} – ${r.end ? fmtDay(r.end, lang, { weekday: false }) : '…'}`}
                  </td>
                  <td className="num">{r.stop_count}</td>
                  <td className="small nowrap">{r.next_date ? fmtDay(r.next_date, lang) : '–'}</td>
                  <td className="small">{status(r)}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    <MenuButton
                      className="btn small"
                      label="⋯"
                      items={[
                        { label: t('routes.editStops'), onClick: () => setDlg({ kind: 'template', id: r.id }) },
                        { label: r.date ? t('rd.editOneOff') : t('rd.editRoute'), onClick: () => setDlg({ kind: 'edit', id: r.id }) },
                        ...(r.date || r.ended ? [] : [{ label: t('routes.changeSchedule'), onClick: () => setDlg({ kind: 'edit', id: r.id, fromD: true }) }]),
                        ...(r.date || r.ended ? [] : [{ label: t('rd.end'), onClick: () => setDlg({ kind: 'end', r }) }]),
                        { label: t('common.delete'), onClick: () => setDlg({ kind: 'delete', r }), danger: true },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">
                    {t('routes.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {dlg?.kind === 'create' && (
        <RouteForm
          mode="create"
          createType={dlg.type}
          date={today}
          dow={today ? weekdayOf(today) : 1}
          onClose={() => setDlg(null)}
          onCreated={(r) => setDlg({ kind: 'template', id: r.id })}
        />
      )}
      {dlg?.kind === 'edit' && <RouteForm mode="edit" routeId={dlg.id} fromD={dlg.fromD} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'end' && (
        <EndDialog
          title={t('rd.endTitle', { code: dlg.r.code })}
          initial={dlg.r.next_date ?? today}
          min={today}
          busy={w.busy}
          error={w.error}
          onSubmit={(from) =>
            void w.run(
              (rel) => patchRoute(dlg.r.id, { rev: dlg.r.rev, end: addDays(from, -1), ...(rel ? { release_run: true } : {}) }),
              () => {
                toast(t('rd.ended', { date: fmtDay(from, lang) }));
                setDlg(null);
              },
            )
          }
          onClose={() => setDlg(null)}
        />
      )}
      {dlg?.kind === 'delete' && (
        <ConfirmDialog
          open
          title={t('rd.deleteRouteTitle', { code: dlg.r.code })}
          confirmLabel={t('common.delete')}
          danger
          busy={w.busy}
          error={w.error}
          onConfirm={() =>
            void w.run(
              (rel) => deleteRoute(dlg.r.id, dlg.r.rev, rel),
              () => {
                toast(t('rd.deleted', { code: dlg.r.code }));
                setDlg(null);
              },
            )
          }
          onClose={() => setDlg(null)}
        >
          <p style={{ margin: 0 }}>{t('rd.deleteRouteText')}</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'template' && <TemplateEditor id={dlg.id} onClose={() => setDlg(null)} />}
      {w.dialog}
    </>
  );
}

/** The route's own stop list (template, or a one-off's list), edited with the same StopList. */
function TemplateEditor({ id, onClose }: { id: number; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const toast = useToast();
  const w = useGuardedWrite();
  const today = meta?.today ?? '';
  const routeQ = useQuery({ queryKey: ['route', id], queryFn: () => getRoute(id) });
  const custQ = useQuery({ queryKey: ['customers', { archived: 'all' }], queryFn: () => listCustomers({ archived: 'all' }), staleTime: 60_000 });
  const route = routeQ.data;
  const base: Stop[] = useMemo(() => route?.stops ?? [], [route]);
  const [draft, setDraft] = useState(() => draftFrom([], ''));
  const [baseSig, setBaseSig] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [extra, setExtra] = useState<Record<number, PickedCustomer>>({});
  const [apply, setApply] = useState<'today' | 'from'>('today');
  const [fromDate, setFromDate] = useState('');
  // Load the template; later refetches replace the draft only while it is clean.
  const sig = JSON.stringify(base);
  useEffect(() => {
    if (!route || sig === baseSig) return;
    const clean = baseSig === null || JSON.stringify(draft.stops) === baseSig;
    setBaseSig(sig);
    if (clean) setDraft(draftFrom(base, ''));
  }, [sig, route]); // eslint-disable-line react-hooks/exhaustive-deps
  const custMap = useMemo(() => new Map((custQ.data ?? []).map((c) => [c.id, c])), [custQ.data]);
  const custOf = (cid: number) => custMap.get(cid) ?? extra[cid];
  const routable = (meta?.waste_types ?? []).filter((x) => x.routable && x.active).map((x) => x.code);
  const ended = !!route && ((route.end && route.end < today) || (route.date && route.date < today));
  const editable = !!route && !ended;
  const dirty = !!route && isDirty(draft, { stops: base, note: '' });

  const save = () => {
    if (!route) return;
    if (route.recurring && apply === 'from') {
      if (!fromDate) return w.setError(t('err.required_field', { field: t('rf.fromDate') }));
      return w.run(
        (rel) => changeRouteSchedule(route.id, { rev: route.rev, from: fromDate, stops: draft.stops, ...(rel ? { release_run: true } : {}) }),
        (r) => {
          for (const x of r.warnings) toast(t(`warn.${x.code}`), 'warn');
          toast(t('rd.savedFollowing', { date: fmtDay(fromDate, lang) }));
          onClose();
        },
      );
    }
    return w.run(
      (rel) => patchRoute(route.id, { rev: route.rev, stops: draft.stops, ...(rel ? { release_run: true } : {}) }),
      (r) => {
        for (const x of r.warnings) toast(t(`warn.${x.code}`), 'warn');
        toast(t('common.saved'));
        onClose();
      },
    );
  };

  return (
    <Drawer
      open
      onClose={onClose}
      color={route?.color}
      label={route?.code}
      title={
        route ? (
          <div className="rd-title">
            <span className="code">{route.code}</span>
            <TypeTag type={route.type} />
            <strong>{route.name}</strong>
          </div>
        ) : (
          <Loading />
        )
      }
      header={
        route && (
          <>
            <div className="rd-rule">{routeRuleText({ ...route, recurring: !!route.recurring }, t, lang, true)}</div>
            <div className="status-box">{ended ? t('routes.endedNote') : route.recurring ? t('routes.templateNote') : t('routes.oneOffNote')}</div>
          </>
        )
      }
      footer={
        <>
          {w.error && <div className="form-error">{w.error}</div>}
          {dirty && route?.recurring && (
            <div className="radio-list">
              <label>
                <input type="radio" checked={apply === 'today'} onChange={() => setApply('today')} /> {t('routes.applyToday')}
              </label>
              <label>
                <input type="radio" checked={apply === 'from'} onChange={() => setApply('from')} /> {t('rf.applyFrom')}
                <input type="date" className="input" style={{ width: 170 }} min={today} value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label={t('rf.fromDate')} />
              </label>
            </div>
          )}
          <div className="acts">
            {dirty && <span className="tag warn">{t('common.unsaved')}</span>}
            <button type="button" className="btn primary" disabled={!dirty || w.busy} onClick={() => void save()}>
              {t('common.save')}
            </button>
            {dirty && (
              <button type="button" className="btn" onClick={() => setDraft(draftFrom(base, ''))}>
                {t('common.discard')}
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      }
    >
      <ErrorBanner error={routeQ.error} />
      {route && (
        <>
          <div className={dirty ? 'stoplist dirty' : 'stoplist'} tabIndex={-1} data-autofocus>
            <StopList
              stops={draft.stops}
              editable={editable}
              view={(s) => {
                const c = custOf(s.customer_id);
                return {
                  name: c?.name ?? `#${s.customer_id}`,
                  detail: [c?.code, c?.address].filter(Boolean).join(' · '),
                  tags: (c?.waste_types ?? [])
                    .filter((x) => routable.includes(x))
                    .map((x) => (
                      <span key={x} className="wtag">
                        {x}
                      </span>
                    )),
                  extra: c && !c.active ? <span className="tag danger">{t('common.archived')}</span> : undefined,
                  isNew: !base.some((b) => b.customer_id === s.customer_id),
                };
              }}
              onChange={(stops) => setDraft((d) => ({ ...d, stops }))}
              onRemove={(i) => setDraft((d) => removeStop(d, i))}
              onNote={(i, n) => setDraft((d) => setStopNote(d, i, n))}
            />
            {draft.stops.length === 0 && <div className="muted small">{t('rd.noStops')}</div>}
          </div>
          {draft.removed.length > 0 && (
            <div className="removed-list">
              {draft.removed.map((s) => (
                <div key={s.customer_id} className="rm">
                  <s>{custOf(s.customer_id)?.name ?? `#${s.customer_id}`}</s>
                  <button type="button" className="linkbtn small" onClick={() => setDraft((d) => restoreStop(d, s.customer_id))}>
                    {t('rd.undoRemove')}
                  </button>
                </div>
              ))}
            </div>
          )}
          {editable &&
            (picking ? (
              <CustomerPicker
                autoFocus
                excludeIds={draft.stops.map((s) => s.customer_id)}
                onPick={(c) => {
                  setExtra((m) => ({ ...m, [c.id]: c }));
                  setDraft((d) => addStop(d, c.id));
                }}
                onClose={() => setPicking(false)}
              />
            ) : (
              <button type="button" className="addcust" onClick={() => setPicking(true)}>
                + {t('rd.addCustomer')}
              </button>
            ))}
        </>
      )}
      {w.dialog}
    </Drawer>
  );
}
