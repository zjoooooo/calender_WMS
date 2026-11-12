// Confirm = claim (R23, §7.3 step 4), used by the route preview. Needs the network; the
// client never shows a claim before the server confirmed it.
//   201 / 200 -> the returned JobDetail becomes the job's data (the page turns into the run / form)
//   409 RUN_TAKEN -> "Taken by Chong 07:45", lists refresh
//   409 DRIVER_HAS_ACTIVE_RUN -> the Switch sheet opens (onSwitchNeeded)
//   422 NOT_TODAY / NOT_RUNNABLE -> lists refresh
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { claimJob, isApiError, prefs, type JobDetail } from '../api';
import { useI18n } from '../i18n';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useDriver } from './driverContext';
import { clearSelfRelease, markSelfRelease, putJob, refreshDriver } from './data';

export const LAST_PLATE = 'driver.plate';

/** The phone's last plate when it is still on the active list. */
export function lastPlate(trucks: string[]): string {
  const p = prefs.get(LAST_PLATE);
  return p && trucks.includes(p) ? p : '';
}

export interface ActiveRun {
  job: string;
  code: string;
  pending: number;
}

export function useClaim(job: JobDetail, onSwitchNeeded: (other: ActiveRun) => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { me, flushNow } = useDriver();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async (plate: string, switchFrom: { code: string } | null) => {
    setBusy(true);
    setError(null);
    try {
      if (switchFrom) await flushNow(); // results of the old route go out first (best effort)
      const r = await claimJob(job.date, job.job, { vehicle_no: plate, switch: !!switchFrom });
      prefs.set(LAST_PLATE, plate);
      clearSelfRelease(job.date, job.job);
      if (r.data.left) markSelfRelease(job.date, r.data.left.job);
      putJob(qc, me.id, r.data.run);
      void refreshDriver(qc);
      if (r.data.left) {
        toast(t('driver.toast.left', { code: switchFrom?.code ?? r.data.left.job, result: t('driver.result.' + r.data.left.result) }), 'info', 5000);
      }
      setBusy(false);
      nav(`/driver/job/${job.date}/${job.job}`, { replace: true });
      return true;
    } catch (e) {
      setBusy(false);
      if (isApiError(e, 'DRIVER_HAS_ACTIVE_RUN')) {
        onSwitchNeeded(e.details as ActiveRun);
        void refreshDriver(qc);
        return false;
      }
      if (isApiError(e, 'RUN_TAKEN') || isApiError(e, 'NOT_TODAY') || isApiError(e, 'NOT_RUNNABLE') || isApiError(e, 'NOT_FOUND')) {
        void refreshDriver(qc);
      }
      setError(errText(e));
      return false;
    }
  };
  return { claim, busy, error, setError };
}
