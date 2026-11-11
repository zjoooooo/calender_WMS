// Office run actions (§6.12, §10.8) for a route or task job:
// - today: [Assign driver…] (drivers with their current route, R24), [Release] (only with a holder),
//   [Close out] (every pending stop becomes missed "not visited"; also creates a holder-less run when none);
// - past: incomplete -> [Close out] [Re-plan leftovers…]; no_record -> [Close out] (results: click a stop).
// Results are entered or corrected in the ResultDialog (click a stop row or the task's result).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assignRun, isApiError, listDrivers, releaseRun, type RouteOccurrence, type TaskOccurrence } from '../api';
import { useI18n } from '../i18n';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { jobOf } from './calendarModel';
import { useInvalidatePlan } from './officeShared';

type Occ = RouteOccurrence | TaskOccurrence;

function labelOf(occ: Occ, customerName?: string): string {
  return occ.kind === 'route' ? occ.code : `${occ.waste_type} ${customerName ?? ''}`.trim();
}

export function RunPanel({ occ, today, customerName, onReplan }: { occ: Occ; today: string; customerName?: string; onReplan?: () => void }) {
  const { t } = useI18n();
  const [dlg, setDlg] = useState<'assign' | 'release' | 'close' | null>(null);
  const date = occ.date;
  if (date > today || (occ.status !== 'scheduled' && !occ.run)) return null;
  const s = occ.run_status;
  const run = occ.run;
  const pending = run ? run.pending : occ.kind === 'route' ? occ.stops.length : 1;
  const isToday = date === today;
  const canAssign = isToday && occ.status === 'scheduled' && pending > 0;
  const canRelease = isToday && !!run?.driver && pending > 0; // a holder holds only while stops are pending (R25)
  const canClose = pending > 0 && !!s && ['not_started', 'active', 'open', 'incomplete', 'no_record'].includes(s);
  const canReplan = !isToday && !!onReplan && pending > 0 && (s === 'incomplete' || s === 'no_record');
  if (!canAssign && !canRelease && !canClose && !canReplan) return null;
  const label = labelOf(occ, customerName);
  return (
    <div className="acts" role="group" aria-label={t('run.actions')}>
      {canAssign && (
        <button type="button" className="btn small" onClick={() => setDlg('assign')}>
          {run?.driver ? t('run.reassign') : t('run.assign')}
        </button>
      )}
      {canRelease && (
        <button type="button" className="btn small" onClick={() => setDlg('release')}>
          {t('run.release')}
        </button>
      )}
      {canClose && (
        <button type="button" className="btn small" onClick={() => setDlg('close')}>
          {t('run.closeOut')}
        </button>
      )}
      {canReplan && (
        <button type="button" className="btn small" onClick={onReplan}>
          {t('run.replan')}
        </button>
      )}
      {dlg === 'assign' && <AssignDialog date={date} job={jobOf(occ)} label={label} onClose={() => setDlg(null)} />}
      {(dlg === 'release' || dlg === 'close') && (
        <ReleaseDialog date={date} job={jobOf(occ)} label={label} driver={run?.driver?.name ?? null} pending={pending} close={dlg === 'close'} onClose={() => setDlg(null)} />
      )}
    </div>
  );
}

function ReleaseDialog(props: { date: string; job: string; label: string; driver: string | null; pending: number; close: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const invalidate = useInvalidatePlan();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await releaseRun(props.date, props.job, props.close ? { mark_missed: true, reason: 'not_visited', note: note.trim() } : { mark_missed: false });
      toast(t(`run.result.${r.result}`, { what: props.label }));
      invalidate();
      props.onClose();
    } catch (e) {
      setError(errText(e));
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={props.close ? t('run.closeOutTitle', { what: props.label }) : t('run.releaseTitle', { what: props.label })}
      confirmLabel={props.close ? t('run.closeOut') : t('run.release')}
      danger={props.close}
      busy={busy}
      error={error}
      onConfirm={submit}
      onClose={props.onClose}
    >
      <p style={{ margin: 0 }}>
        {props.close ? t('run.closeOutText', { n: props.pending }) : t('run.releaseText', { driver: props.driver ?? '' })}
      </p>
      {props.close && (
        <label className="field">
          <span>{t('common.note')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      )}
    </ConfirmDialog>
  );
}

function AssignDialog(props: { date: string; job: string; label: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const invalidate = useInvalidatePlan();
  const q = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: number; name: string; code: string; pending: number } | null>(null);
  const assign = async (id: number, name: string, sw: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await assignRun(props.date, props.job, { driver_id: id, switch: sw });
      toast(t('run.assigned', { what: props.label, name }));
      invalidate();
      props.onClose();
    } catch (e) {
      if (isApiError(e, 'DRIVER_HAS_ACTIVE_RUN')) {
        setConflict({ id, name, code: String(e.details?.code ?? e.details?.job ?? ''), pending: Number(e.details?.pending ?? 0) });
      } else {
        setError(errText(e));
      }
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  const drivers = (q.data ?? []).filter((d) => d.active);
  return (
    <Dialog open title={t('run.assignTitle', { what: props.label })} onClose={props.onClose} width={460}>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {conflict ? (
        <div className="stack">
          <div className="banner warn">{t('run.switchQ', { name: conflict.name, code: conflict.code, n: conflict.pending })}</div>
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConflict(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => assign(conflict.id, conflict.name, true)}>
              {t('run.switchAndAssign')}
            </button>
          </div>
        </div>
      ) : (
        <div className="drivers">
          {drivers.map((d) => (
            <button key={d.id} type="button" disabled={busy} onClick={() => assign(d.id, d.name, false)}>
              <strong>{d.name}</strong>
              <span className="muted small">
                {d.route_job ? t('run.holdsRoute', { code: d.route_job.code, n: d.route_job.pending }) : t('run.free')}
                {d.task_jobs.length ? ` · ${t('run.holdsTasks', { n: d.task_jobs.length })}` : ''}
              </span>
            </button>
          ))}
          {q.isSuccess && drivers.length === 0 && <div className="muted">{t('run.noDrivers')}</div>}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
