// Route drawer for one (route, date) (§6.1–§6.5, §6.11, §6.12).
// Header: colour bar, CODE, type tag, name, the rule, the note and the status line.
// Body: the stop list as a local DRAFT (add routable customers via search, remove, reorder by drag and drop,
// ↑ ↓ or "move to #", stop notes, the occurrence note). The draft has an amber outline, keeps removed rows
// struck through (with Undo), survives the 30 s refetch and is saved only by [Save]: a one-off saves
// directly, a recurring route asks the scope (only this date / this date and following).
// R20: the draft keeps the server version (rev, stops, note) it was started from. A clean draft follows
// every refetch; an edited one keeps its base, says when someone else saved meanwhile, and its save sends
// the base rev, so the server answers STALE_REVISION instead of silently dropping the other change. After
// that answer the next [Save] replaces the other version on purpose (or [Discard] loads it).
// Footer: run actions (assign, release, close out, re-plan) and a menu: skip / restore / reset, copy to
// date, edit route / schedule, end from date, delete. Past dates are a read-only plan; results can still be
// entered or corrected (click a customer).
// A split route (R12 / R14) is one route here: the header shows the whole route's period, the delete dialog
// names every part it removes, and "End route from D" goes to the part that runs on D (routeChain).
// The End and Delete dialogs show their own error; it is cleared when a dialog opens or closes.
import { useEffect, useMemo, useState } from 'react';
import { deleteRoute, isApiError, patchRoute, putRouteDate, resetRouteDate, type RouteOccurrence, type Stop } from '../api';
import { fmtDay, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { TypeTag } from '../ui/Chip';
import { ConfirmDialog } from '../ui/Dialog';
import { Drawer } from '../ui/Drawer';
import { useToast } from '../ui/Toast';
import { useCalendar } from './calendarContext';
import { addDays, jobOf, routesByCustomer, tasksByCustomer } from './calendarModel';
import { EndDialog } from './CopyDialog';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { MenuButton, routeRuleText, runDetailText, useGuardedWrite, workDone, type MenuItem } from './officeShared';
import { ResultDialog, type ResultTarget } from './ResultDialog';
import { RouteForm } from './RouteForm';
import { chainPeriod, endTarget, liveChain, routeChain, segmentPeriods, useAllRoutes } from './routeChain';
import { RunPanel } from './RunActions';
import { ScopeDialog, type Scope } from './ScopeDialog';
import { StopList, type StopRowView } from './StopList';
import { addStop, draftDiff, draftFrom, isDirty, removeStop, restoreStop, sameStops, setStopNote } from './stopDraft';

export function RouteDrawer({ occ, onClose }: { occ: RouteOccurrence; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { data, open } = useCalendar();
  const toast = useToast();
  const w = useGuardedWrite();
  const today = data.today;
  const day = data.days.find((d) => d.date === occ.date);
  const past = day ? day.past : occ.date < today;
  const editable = !past && occ.status === 'scheduled' && !occ.frozen && !occ.orphan;
  const types = meta?.waste_types ?? [];
  const routable = types.filter((x) => x.routable && x.active).map((x) => x.code);

  // ---- draft (survives refetches; re-synced from the server only while it is clean) ----
  // baseStops / baseNote: the server's current version; `base`: the version the draft was started from.
  const baseStops: Stop[] = useMemo(() => occ.stops.map((s) => ({ customer_id: s.customer_id, note: s.note ?? '' })), [occ.stops]);
  const baseNote = (occ.recurring ? occ.occurrence_note : occ.route_note) ?? (occ.recurring ? '' : occ.note);
  const [draft, setDraft] = useState(() => draftFrom(baseStops, baseNote));
  const [base, setBase] = useState(() => ({ rev: occ.rev, stops: baseStops, note: baseNote }));
  const sig = JSON.stringify([baseStops, baseNote, occ.rev]);
  const [baseSig, setBaseSig] = useState(sig);
  const dirty = isDirty(draft, base);
  const reload = () => {
    setDraft(draftFrom(baseStops, baseNote));
    setBase({ rev: occ.rev, stops: baseStops, note: baseNote });
  };
  useEffect(() => {
    if (sig === baseSig) return;
    setBaseSig(sig);
    if (!dirty || (sameStops(draft.stops, baseStops) && draft.note === baseNote)) reload();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // Someone else saved this date while the draft was being edited (R20).
  const changedMeanwhile = dirty && (base.rev !== occ.rev || !sameStops(base.stops, baseStops) || base.note !== baseNote);

  const [picking, setPicking] = useState(false);
  const [extraCust, setExtraCust] = useState<Record<number, PickedCustomer>>({});
  const [scopeOpen, setScopeOpen] = useState(false);
  const [dlg, setDlgState] = useState<'edit' | 'end' | 'delete' | null>(null);
  const setDlg = (d: 'edit' | 'end' | 'delete' | null) => {
    w.setError(null);
    setDlgState(d);
  };
  const [result, setResult] = useState<ResultTarget | null>(null);

  const dateOcc = useMemo(() => data.routes.filter((o) => o.date === occ.date), [data.routes, occ.date]);
  const alsoOnRoutes = useMemo(() => routesByCustomer(dateOcc, occ.route_id), [dateOcc, occ.route_id]);
  const alsoOnTasks = useMemo(() => tasksByCustomer(data.tasks.filter((o) => o.date === occ.date)), [data.tasks, occ.date]);
  const visits = new Map(occ.stops.map((s) => [s.customer_id, s.visit]));
  const custOf = (id: number) => data.customers[String(id)] ?? extraCust[id];
  const canResult = occ.date <= today && (occ.status === 'scheduled' || !!occ.run);
  const job = jobOf(occ);
  const holderId = occ.run?.driver?.id ?? null;
  const typeAbbr = (code: string) => types.find((x) => x.code === code)?.abbr || code;
  // The whole route when it is split (R12 / R14): its parts, and the ones an end or a delete reaches.
  const allQ = useAllRoutes(occ.recurring && !occ.orphan);
  const chain = useMemo(() => (occ.recurring && allQ.data ? routeChain(allQ.data, occ.route_id) : []), [allQ.data, occ.recurring, occ.route_id]);
  const live = useMemo(() => (occ.recurring && allQ.data ? liveChain(allQ.data, occ.route_id, today) : []), [allQ.data, occ.recurring, occ.route_id, today]);
  const period =
    occ.route_start !== undefined && occ.route_end !== undefined
      ? { start: occ.route_start, end: occ.route_end }
      : chain.length
        ? chainPeriod(chain)
        : { start: occ.start ?? null, end: occ.end ?? null };

  const openResult = (cid: number) => {
    const c = custOf(cid);
    const own = (c?.waste_types ?? []).filter((x) => routable.includes(x));
    setResult({
      date: occ.date,
      job,
      customerId: cid,
      customerName: c?.name ?? `#${cid}`,
      weighTypes: own.length ? own : routable, // a detached OFF_PLAN customer may be weighed in any routable type (R27)
      defaultDriverId: holderId,
    });
  };

  const visitText = (cid: number) => {
    const v = visits.get(cid);
    if (!v || !v.outcome) return null;
    if (v.outcome === 'collected') {
      const ws = Object.entries(v.weights ?? {})
        .map(([k, x]) => `${typeAbbr(k)} ${fmtWeight(Number(x))}`)
        .join(' · ');
      return (
        <span className="vis-ok">
          ✓ {ws} {v.driver ? `· ${v.driver}` : ''} {v.photos ? `· 📷${v.photos}` : ''} {v.signature ? '· ✍' : ''}
          {v.flags.map((f) => (
            <span key={f} className="flag" style={{ marginLeft: 4 }}>
              {f}
            </span>
          ))}
        </span>
      );
    }
    return (
      <span className="vis-miss">
        ✗ {v.reason ? t(`reason.${v.reason}`) : t('status.notCollected')} {v.driver ? `· ${v.driver}` : ''}
      </span>
    );
  };

  const rowView = (s: Stop): StopRowView => {
    const c = custOf(s.customer_id);
    const v = visits.get(s.customer_id);
    const tasks = alsoOnTasks.get(s.customer_id) ?? [];
    const also = alsoOnRoutes.get(s.customer_id) ?? [];
    const vt = visitText(s.customer_id);
    const extra = [
      vt ? <span key="v">{vt}</span> : null,
      tasks.length > 0 ? <span key="t" className="muted">{t('rd.alsoTask', { types: tasks.map(typeAbbr).join(', ') })}</span> : null,
      also.length > 0 ? <span key="a" className="muted">{t('picker.alsoOn', { codes: also.join(', ') })}</span> : null,
      c && !c.active ? <span key="x" className="tag danger">{t('common.archived')}</span> : null,
    ].filter(Boolean);
    return {
      name: c?.name ?? `#${s.customer_id}`,
      detail: [c?.code, c?.address].filter(Boolean).join(' · '),
      tags: (c?.waste_types ?? [])
        .filter((x) => routable.includes(x))
        .map((x) => (
          <span key={x} className="wtag">
            {typeAbbr(x)}
          </span>
        )),
      extra: extra.length ? extra : undefined,
      locked: !!v?.outcome,
      done: !!v?.outcome,
      isNew: !base.stops.some((b) => b.customer_id === s.customer_id),
      onOpen: canResult ? () => openResult(s.customer_id) : undefined,
    };
  };

  // ---- writes ----
  // Only what this draft changed is sent, with the rev it is based on (R20).
  const stopsChanged = !sameStops(draft.stops, base.stops);
  const noteChanged = draft.note !== base.note;
  const save = (scope: Scope) =>
    w.run(
      async (rel) => {
        try {
          return await putRouteDate(occ.route_id, occ.date, {
            rev: base.rev,
            scope,
            ...(stopsChanged ? { stops: draft.stops } : {}),
            ...(noteChanged ? { note: draft.note } : {}),
            ...(rel ? { release_run: true } : {}),
          });
        } catch (e) {
          if (isApiError(e, 'STALE_REVISION')) {
            // Shown and refetched: the draft stays, and the next [Save] replaces the other version on purpose.
            const current = Number((e.details as { current?: unknown } | null)?.current);
            setBase((b) => ({ ...b, rev: Number.isFinite(current) && current > 0 ? current : occ.rev }));
            setScopeOpen(false);
          }
          throw e;
        }
      },
      (r) => {
        for (const x of r.warnings) toast(t(`warn.${x.code}`), 'warn');
        toast(scope === 'following' && occ.recurring ? t('rd.savedFollowing', { date: fmtDay(occ.date, lang) }) : t('rd.savedThis', { date: fmtDay(occ.date, lang) }));
        setScopeOpen(false);
        onClose();
      },
    );
  const onSave = () => {
    if (occ.recurring && stopsChanged) setScopeOpen(true);
    else void save('this');
  };
  const setCancelled = (cancelled: boolean) =>
    w.run(
      (rel) => putRouteDate(occ.route_id, occ.date, { rev: occ.rev, scope: 'this', cancelled, ...(rel ? { release_run: true } : {}) }),
      () => toast(cancelled ? t('rd.skipped', { date: fmtDay(occ.date, lang) }) : t('rd.restored')),
    );
  const reset = () => w.run((rel) => resetRouteDate(occ.route_id, occ.date, occ.rev, rel), () => toast(t('rd.reset')));
  const endFrom = (from: string) => {
    // The part that runs on D gets end = D − 1 (opened from a later part, D can be in an earlier one).
    const seg = endTarget(live, from);
    const target = seg && seg.id !== occ.route_id ? { id: seg.id, rev: seg.rev } : { id: occ.route_id, rev: occ.rev };
    return w.run(
      (rel) => patchRoute(target.id, { rev: target.rev, end: addDays(from, -1), ...(rel ? { release_run: true } : {}) }),
      () => {
        toast(t('rd.ended', { date: fmtDay(from, lang) }));
        setDlg(null);
      },
    );
  };
  const remove = () =>
    w.run(
      (rel) => deleteRoute(occ.route_id, occ.rev, rel),
      () => {
        toast(t('rd.deleted', { code: occ.code }));
        setDlg(null);
        onClose();
      },
    );

  // ---- menu ----
  const isToday = occ.date === today;
  const blocked = isToday && workDone(occ.run);
  const blockedTip = blocked ? t('rd.hasJob', { name: occ.run?.driver?.name ?? occ.run?.holders.slice(-1)[0] ?? '' }) : undefined;
  const items: (MenuItem | null)[] = [];
  if (!past && !occ.orphan) {
    if (occ.recurring) {
      if (occ.status === 'scheduled') items.push({ label: t('rd.skip'), onClick: () => void setCancelled(true), disabled: blocked, title: blockedTip });
      if (occ.status === 'cancelled') items.push({ label: t('rd.restore'), onClick: () => void setCancelled(false) });
      if (occ.edited) items.push({ label: t('rd.reset'), onClick: () => void reset() });
    }
    if (occ.status === 'holiday_skipped') {
      items.push({ label: t('copy.runOnPh'), onClick: () => open({ kind: 'copy', occ, mode: 'ph' }) });
      items.push({ label: t('copy.moveWorkDay'), onClick: () => open({ kind: 'copy', occ, mode: 'move' }) });
    } else {
      items.push({ label: t('copy.title') + '…', onClick: () => open({ kind: 'copy', occ, mode: 'copy' }) });
    }
    items.push(null);
    items.push({ label: occ.recurring ? t('rd.editRoute') : t('rd.editOneOff'), onClick: () => setDlg('edit') });
    if (occ.recurring) items.push({ label: t('rd.end'), onClick: () => setDlg('end'), disabled: blocked, title: blockedTip });
    items.push({ label: occ.recurring ? t('rd.deleteRoute') : t('rd.deleteOneOff'), onClick: () => setDlg('delete'), danger: true, disabled: blocked, title: blockedTip });
  } else if (!occ.orphan) {
    items.push({ label: t('copy.title') + '…', onClick: () => open({ kind: 'copy', occ, mode: 'copy' }) });
  }

  // ---- header status line ----
  const covered = occ.covered_by.map((c) => `${c.code} ${fmtDay(c.date, lang)}`).join(', ');
  let statusLine: string;
  if (occ.orphan) statusLine = t('rd.orphan');
  else if (occ.status === 'holiday_skipped') statusLine = covered ? t('rd.pausedCovered', { what: covered }) : t('rd.paused');
  else if (occ.status === 'cancelled') statusLine = covered ? t('rd.cancelledCovered', { what: covered }) : t('rd.cancelled');
  else if (occ.date > today) statusLine = t('rd.planned', { n: occ.stops.length });
  else statusLine = runDetailText(occ.run_status, occ.run, t, types, meta?.now) || t('status.planned');

  const replan = () => {
    const pending = occ.stops.filter((s) => !s.visit?.outcome).map((s) => s.customer_id);
    onClose();
    open({ kind: 'urgent', customers: pending });
  };

  const diff = draftDiff(baseStops, draft);
  const nameOf = (id: number) => custOf(id)?.name ?? `#${id}`;
  const theyAdded = baseStops.filter((s) => !base.stops.some((b) => b.customer_id === s.customer_id)).map((s) => nameOf(s.customer_id));
  const theyRemoved = base.stops.filter((b) => !baseStops.some((s) => s.customer_id === b.customer_id)).map((s) => nameOf(s.customer_id));
  const offPlan = occ.off_plan ?? [];
  return (
    <>
      <Drawer
        open
        onClose={onClose}
        color={occ.color}
        label={`${occ.code} ${occ.name}`}
        title={
          <div className="rd-title">
            <span className="code">
              {occ.type === 'adhoc' ? '⚡' : ''}
              {occ.code}
            </span>
            <TypeTag type={occ.type} />
            <strong title={occ.name}>{occ.name}</strong>
            {occ.edited && <span className="tag warn">{t('cal.edited')}</span>}
          </div>
        }
        header={
          <>
            <div className="rd-rule">
              {fmtDay(occ.date, lang)} · {routeRuleText({ ...occ, ...period }, t, lang, true)}
              {occ.route_note && (occ.recurring || !editable) ? ` · ${occ.route_note}` : ''}
            </div>
            <div className="status-box" role="status">
              {past && !occ.orphan ? `🔒 ${t('rd.pastNote')} ` : ''}
              {statusLine}
            </div>
          </>
        }
        footer={
          dirty ? (
            <>
              <div className="row">
                <span className="tag warn">{t('common.unsaved')}</span>
                <span className="muted small">{t('rd.draftHint')}</span>
              </div>
              {w.error && !scopeOpen && (
                <div className="form-error" role="alert">
                  {w.error}
                </div>
              )}
              <div className="acts">
                <button type="button" className="btn primary" disabled={w.busy} onClick={onSave}>
                  {t('common.save')}
                </button>
                <button type="button" className="btn" onClick={reload}>
                  {t('common.discard')}
                </button>
              </div>
            </>
          ) : (
            <>
              {w.error && !dlg && (
                <div className="form-error" role="alert">
                  {w.error}
                </div>
              )}
              <div className="acts">
                <RunPanel occ={occ} today={today} onReplan={occ.date < today ? replan : undefined} />
                <span className="spacer" />
                {items.length > 0 && <MenuButton label={`${t('common.menu')} ▾`} items={items} up />}
                <button type="button" className="btn" onClick={onClose}>
                  {t('common.close')}
                </button>
              </div>
            </>
          )
        }
      >
        {changedMeanwhile && (
          <div className="banner warn" role="status" data-testid="changed-meanwhile">
            <div>{t('rd.changedMeanwhile')}</div>
            {theyAdded.length > 0 && <div className="small">{t('rd.theyAdded', { names: theyAdded.join(', ') })}</div>}
            {theyRemoved.length > 0 && <div className="small">{t('rd.theyRemoved', { names: theyRemoved.join(', ') })}</div>}
          </div>
        )}
        <div className={dirty ? 'stoplist dirty' : 'stoplist'} tabIndex={-1} data-autofocus aria-label={t('rd.stops')}>
          <StopList
            stops={draft.stops}
            view={rowView}
            editable={editable}
            onChange={(stops) => setDraft((d) => ({ ...d, stops }))}
            onRemove={(i) => setDraft((d) => removeStop(d, i))}
            onNote={(i, n) => setDraft((d) => setStopNote(d, i, n))}
          />
          {draft.stops.length === 0 && <div className="muted small">{t('rd.noStops')}</div>}
        </div>
        {draft.removed.length > 0 && (
          <div className="removed-list" aria-label={t('rd.removed')}>
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
        {offPlan.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <strong className="small">{t('rd.offPlan')}</strong>
            {offPlan.map((s) => (
              <div key={s.customer_id} className="row small">
                <button type="button" className="linkbtn" onClick={() => openResult(s.customer_id)}>
                  {custOf(s.customer_id)?.name ?? `#${s.customer_id}`}
                </button>
                {s.visit.outcome === 'collected' ? (
                  <span className="vis-ok">
                    ✓{' '}
                    {Object.entries(s.visit.weights)
                      .map(([k, x]) => `${typeAbbr(k)} ${fmtWeight(Number(x))}`)
                      .join(' · ')}
                  </span>
                ) : (
                  <span className="vis-miss">✗</span>
                )}
                <span className="flag">OFF_PLAN</span>
              </div>
            ))}
          </div>
        )}
        {editable &&
          (picking ? (
            <CustomerPicker
              autoFocus
              excludeIds={draft.stops.map((s) => s.customer_id)}
              alsoOn={alsoOnRoutes}
              onPick={(c) => {
                setExtraCust((m) => ({ ...m, [c.id]: c }));
                setDraft((d) => addStop(d, c.id));
              }}
              onClose={() => setPicking(false)}
            />
          ) : (
            <button type="button" className="addcust" onClick={() => setPicking(true)}>
              + {t('rd.addCustomer')}
            </button>
          ))}
        {editable ? (
          <label className="field">
            <span>{occ.recurring ? t('rd.occNote', { date: fmtDay(occ.date, lang) }) : t('common.note')}</span>
            <textarea value={draft.note} maxLength={500} rows={2} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
          </label>
        ) : (
          occ.occurrence_note && <div className="note">📝 {occ.occurrence_note}</div>
        )}
        {canResult && <div className="lockmsg">{t('rd.resultHint')}</div>}
      </Drawer>

      {scopeOpen && (
        <ScopeDialog
          occ={occ}
          today={today}
          stops={draft.stops}
          nameOf={(id) => custOf(id)?.name}
          added={diff.added.length}
          removed={diff.removed.length}
          busy={w.busy}
          error={w.error}
          onSave={(s) => void save(s)}
          onClose={() => setScopeOpen(false)}
        />
      )}
      {dlg === 'edit' && <RouteForm mode="edit" routeId={occ.route_id} date={occ.date > today ? occ.date : undefined} onClose={() => setDlg(null)} />}
      {dlg === 'end' && (
        <EndDialog
          title={t('rd.endTitle', { code: occ.code })}
          initial={occ.date}
          min={today}
          busy={w.busy}
          error={w.error}
          onSubmit={(d) => void endFrom(d)}
          onClose={() => setDlg(null)}
        />
      )}
      <ConfirmDialog
        open={dlg === 'delete'}
        title={occ.recurring ? t('rd.deleteRouteTitle', { code: occ.code }) : t('rd.deleteOneOffTitle', { code: occ.code, date: fmtDay(occ.date, lang) })}
        confirmLabel={t('common.delete')}
        danger
        busy={w.busy}
        error={w.error}
        onConfirm={() => void remove()}
        onClose={() => setDlg(null)}
      >
        <p style={{ margin: 0 }} data-testid="delete-text">
          {!occ.recurring
            ? t('rd.deleteOneOffText')
            : live.length > 1
              ? t('rd.deleteSplitText', {
                  code: occ.code,
                  n: live.length,
                  periods: segmentPeriods(live, (d) => fmtDay(d, lang, { weekday: false }), (d) => t('rule.from', { date: d })).join(', '),
                })
              : t('rd.deleteRouteText')}
        </p>
      </ConfirmDialog>
      {result && <ResultDialog target={result} onClose={() => setResult(null)} />}
      {w.dialog}
    </>
  );
}
