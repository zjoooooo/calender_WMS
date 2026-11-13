// Routes page (§9.2): table (colour, code, type, name, schedule, start/end, stops, next date, today's
// status) with a filter that shows ended routes; the template editor (the same StopList as the route drawer:
// drag and drop, ↑ ↓, move to #); actions [Edit route…], [Change schedule from date…], [End], [Delete].
// A template save applies from today (PATCH stops) or from a later date D (change-schedule with stops, R14).
// A split route (R12 / R14) has one record per part. Its rows stay together, each marked "part k of n";
// edit, end and delete act on the whole route (the delete dialog names every part it removes, an end goes
// to the part that runs on that date). Each part has its own customer list: the template editor's note
// names the other parts' dates and says whether a change from today reaches them (SPLIT-UI-08). Round 6:
// before a save, each other part whose customers after it differ from the list being saved is named, with
// the customers it also has and the ones it does not have (routeCarry, the server's rule). The notices
// scroll in a capped area above Save, so the list and Save stay on screen however many parts are named, and
// the save sends the parts they were computed on (refused with STALE_REVISION if one changed meanwhile).
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
import { fmtDay, useI18n, weekdayName, weekdayOf } from '../i18n';
import { useSession } from '../session';
import { TypeTag, WasteTag } from '../ui/Chip';
import { ConfirmDialog } from '../ui/Dialog';
import { Drawer } from '../ui/Drawer';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import type { CreateKind } from './calendarContext';
import { addDays } from './calendarModel';
import { EndDialog } from './CopyDialog';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { MenuButton, routeRuleText, useGuardedWrite } from './officeShared';
import { keptListsTemplate, keptListText, partsRev } from './routeCarry';
import { chainPeriod, endTarget, liveChain, routeChain, segmentLive, segmentOn, segmentPeriods, useAllRoutes } from './routeChain';
import { RouteForm } from './RouteForm';
import { StopList } from './StopList';
import { addStop, dayCounts, draftFrom, isDirty, removeStop, restoreStop, sameStops, setStopDays, setStopNote } from './stopDraft';
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
  // Parts of split routes among the listed rows: id -> {k, n, split dates}.
  const parts = useMemo(() => {
    const m = new Map<number, { k: number; n: number; dates: string[] }>();
    for (const r of q.data ?? []) {
      if (m.has(r.id)) continue;
      const c = routeChain(q.data ?? [], r.id);
      if (c.length < 2) continue;
      c.forEach((x, i) => m.set(x.id, { k: i + 1, n: c.length, dates: c.slice(1).map((y) => y.start ?? '') }));
    }
    return m;
  }, [q.data]);
  // A part of a split route shows the route's next date (its own part may have none left).
  const nextOf = (r: RouteListItem) => (r.route_next_date !== undefined && parts.has(r.id) ? r.route_next_date : r.next_date);
  const endedPart = (r: RouteListItem) => !!r.ended && parts.has(r.id) && routeChain(q.data ?? [], r.id).some((x) => segmentLive(x, today));
  const fmtShort = (d: string) => fmtDay(d, lang, { weekday: false });
  const livePeriods = (id: number) => liveChain(q.data ?? [], id, today);
  const delParts = dlg?.kind === 'delete' ? livePeriods(dlg.r.id) : [];
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
                <tr
                  key={r.id}
                  className={[r.ended ? 'dim' : '', 'clickable', (parts.get(r.id)?.k ?? 1) > 1 ? 'chain-cont' : ''].filter(Boolean).join(' ')}
                  data-code={r.code}
                  onClick={() => setDlg({ kind: 'template', id: r.id })}
                >
                  <td>
                    <span className="rcode code">
                      {r.type === 'adhoc' ? '⚡' : ''}
                      {r.code}
                    </span>
                  </td>
                  <td>
                    <TypeTag type={r.type} /> <WasteTag code={r.waste_type} abbr={(meta?.waste_types ?? []).find((x) => x.code === r.waste_type)?.abbr} />
                  </td>
                  <td>{r.name}</td>
                  <td className="small">{routeRuleText({ ...r, recurring: r.recurring ?? !r.date }, t, lang).split(' · ').slice(1).join(' · ')}</td>
                  <td className="small nowrap">
                    {r.date ? fmtDay(r.date, lang) : `${fmtDay(r.start ?? '', lang, { weekday: false })} – ${r.end ? fmtDay(r.end, lang, { weekday: false }) : '…'}`}
                    {parts.has(r.id) && (
                      <>
                        {' '}
                        <span
                          className="tag"
                          data-testid="part"
                          title={t('routes.partTitle', { code: r.code, date: parts.get(r.id)!.dates.map((d) => fmtDay(d, lang)).join(', ') })}
                        >
                          {t('routes.part', { k: parts.get(r.id)!.k, n: parts.get(r.id)!.n })}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="num">{r.stop_count}</td>
                  <td className="small nowrap">{nextOf(r) ? fmtDay(nextOf(r)!, lang) : '–'}</td>
                  <td className="small">{status(r)}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    <MenuButton
                      className="btn small"
                      label="⋯"
                      items={[
                        { label: t('routes.editStops'), onClick: () => setDlg({ kind: 'template', id: r.id }) },
                        // An ended part of a route that still runs is history: the route is edited from a current part.
                        ...(endedPart(r) ? [] : [{ label: r.date ? t('rd.editOneOff') : t('rd.editRoute'), onClick: () => setDlg({ kind: 'edit', id: r.id }) }]),
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
          onSubmit={(from) => {
            const target = endTarget(livePeriods(dlg.r.id), from) ?? dlg.r;
            void w.run(
              (rel) => patchRoute(target.id, { rev: target.rev, end: addDays(from, -1), ...(rel ? { release_run: true } : {}) }),
              () => {
                toast(t('rd.ended', { date: fmtDay(from, lang) }));
                setDlg(null);
              },
            );
          }}
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
          <p style={{ margin: 0 }} data-testid="delete-text">
            {delParts.length > 1
              ? t('rd.deleteSplitText', {
                  code: dlg.r.code,
                  n: delParts.length,
                  periods: segmentPeriods(delParts, fmtShort, (d) => t('rule.from', { date: d })).join(', '),
                })
              : t('rd.deleteRouteText')}
          </p>
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
  const allQ = useAllRoutes();
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
    const clean = baseSig === null || sameStops(draft.stops, JSON.parse(baseSig) as Stop[]);
    setBaseSig(sig);
    if (clean) setDraft(draftFrom(base, ''));
  }, [sig, route]); // eslint-disable-line react-hooks/exhaustive-deps
  const custMap = useMemo(() => new Map((custQ.data ?? []).map((c) => [c.id, c])), [custQ.data]);
  const custOf = (cid: number) => custMap.get(cid) ?? extra[cid];
  const routable = (meta?.waste_types ?? []).filter((x) => x.routable && x.active).map((x) => x.code);
  const ended = !!route && ((route.end && route.end < today) || (route.date && route.date < today));
  const editable = !!route && !ended;
  const dirty = !!route && isDirty(draft, { stops: base, note: '' });
  // A split route: the whole route's period for the header; the other live parts keep their own list.
  const chain = route && route.recurring && allQ.data ? routeChain(allQ.data.map((x) => (x.id === route.id ? { ...x, ...route } : x)), route.id) : [];
  const live = route && route.recurring && allQ.data ? liveChain(allQ.data.map((x) => (x.id === route.id ? { ...x, ...route } : x)), route.id, today) : [];
  const others = live.filter((x) => x.id !== route?.id);
  const fmtShort = (d: string) => fmtDay(d, lang, { weekday: false });
  const fromWord = (d: string) => t('rule.from', { date: d });
  // A stop may have its own collection weekdays only in the standing list of a recurring regular route.
  const stopDays = route?.recurring && route.type === 'regular' ? (route.days ?? undefined) : undefined;
  // What the other parts keep after this save (from today: every other part; from D: the parts from D on),
  // once the customer names are loaded.
  const kept = useMemo(
    () =>
      dirty && route?.recurring && !custQ.isPending && (apply === 'today' || fromDate)
        ? keptListsTemplate(route.parts ?? [], route.id, draft.stops, apply === 'from' ? fromDate : null, today)
        : [],
    [dirty, route, custQ.isPending, apply, fromDate, draft.stops, today],
  );

  const save = () => {
    if (!route) return;
    // The parts the notices were computed on (§6.5): the server refuses the save if one changed meanwhile.
    const parts = partsRev(route.parts);
    if (route.recurring && apply === 'from') {
      if (!fromDate) return w.setError(t('err.required_field', { field: t('rf.fromDate') }));
      // A split route: the schedule change goes to the part that runs on D.
      const seg = segmentOn(live, fromDate);
      const target = seg && seg.id !== route.id ? { id: seg.id, rev: seg.rev } : { id: route.id, rev: route.rev };
      return w.run(
        (rel) => changeRouteSchedule(target.id, { rev: target.rev, from: fromDate, stops: draft.stops, ...(parts ? { parts } : {}), ...(rel ? { release_run: true } : {}) }),
        (r) => {
          for (const x of r.warnings) toast(t(`warn.${x.code}`), 'warn');
          toast(t('rd.savedFollowing', { date: fmtDay(fromDate, lang) }));
          onClose();
        },
      );
    }
    return w.run(
      (rel) => patchRoute(route.id, { rev: route.rev, stops: draft.stops, ...(parts ? { parts } : {}), ...(rel ? { release_run: true } : {}) }),
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
            <div className="rd-rule">{routeRuleText({ ...route, recurring: !!route.recurring, ...(chain.length ? chainPeriod(chain) : {}) }, t, lang, true)}</div>
            <div className="status-box" data-testid="template-note">
              {ended
                ? t('routes.endedNote')
                : !route.recurring
                  ? t('routes.oneOffNote')
                  : !others.length
                    ? t('routes.templateNote')
                    : typeof route.series === 'number'
                      ? // A server that links the parts (series) carries a template change into every live part.
                        t('routes.chainNote', { code: route.code, periods: segmentPeriods(live, fmtShort, fromWord).join(', ') })
                      : t('routes.segmentNote', {
                          code: route.code,
                          period: segmentPeriods([route], fmtShort, fromWord)[0],
                          others: segmentPeriods(others, fmtShort, fromWord).join(', '),
                        })}
            </div>
            {stopDays && draft.stops.some((s) => s.days) && (
              <div className="muted small" data-testid="day-counts">
                {dayCounts(draft.stops, stopDays)
                  .map((n, i) => `${weekdayName(stopDays[i], lang)} ${n}`)
                  .join(' · ')}
              </div>
            )}
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
          {kept.length > 0 && (
            <div className="kept-notes">
              {kept.map((k) => (
                <div key={k.part.id} className="banner info" data-testid="kept-list">
                  {keptListText(k, today, t, lang, (cid) => custOf(cid)?.name ?? `#${cid}`)}
                </div>
              ))}
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
              routeDays={stopDays}
              onDays={(i, days) => setDraft((d) => setStopDays(d, i, days, stopDays ?? []))}
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
                wasteType={route.waste_type}
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
