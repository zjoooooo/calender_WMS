// "Blocked by a run" dialog (R26, §6.11). Shown when a write returns 409 RUN_EXISTS
// {runs:[{job, code_or_customer, driver, resolved}]}.
// - Nothing done yet (every resolved = 0): "Ali has N1 (0 done). [Release the driver and continue]";
//   the caller resends the same write with release_run = true.
// - Work done: "Refused: Ali has done 3 on N1 …" and only Close. When nobody holds the job any more (the
//   office released it after work was done), "Refused: 3 stops of E1 are already done today (no driver
//   holds it now) …" under the title "Work is already done on this job today" (SPLIT-UI-10).
// Reusable by every office write that can hit R26 (customers, holidays, routes).
import type { ApiError } from '../api';
import { useI18n } from '../i18n';
import { Dialog } from '../ui/Dialog';

export interface BlockingRun {
  job: string;
  code_or_customer: string;
  driver: string | null;
  resolved: number;
}

export function blockingRuns(e: ApiError | null | undefined): BlockingRun[] {
  const runs = e?.details?.runs;
  return Array.isArray(runs) ? runs : [];
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The dialog's title: a driver holds the job, or nobody does any more but work is done. */
export function runExistsTitle(t: T, runs: BlockingRun[]): string {
  return runs.length === 0 || runs.some((r) => r.driver) ? t('runExists.title') : t('runExists.titleDone');
}

/** One line per blocking run. */
export function runExistsLine(t: T, r: BlockingRun): string {
  if (!r.resolved) return t('runExists.noneDone', { driver: r.driver || t('runExists.nobody'), what: r.code_or_customer });
  return r.driver
    ? t('runExists.refused', { driver: r.driver, what: r.code_or_customer, resolved: r.resolved })
    : t('runExists.refusedNoDriver', { what: r.code_or_customer, resolved: r.resolved });
}

export function RunExistsDialog(props: { error: ApiError | null; busy?: boolean; onRelease: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const runs = blockingRuns(props.error);
  const canRelease = runs.length > 0 && runs.every((r) => !r.resolved);
  return (
    <Dialog
      open={!!props.error}
      title={runExistsTitle(t, runs)}
      onClose={props.onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {canRelease ? t('common.cancel') : t('common.close')}
          </button>
          {canRelease && (
            <button type="button" className="btn primary" onClick={props.onRelease} disabled={props.busy} data-autofocus>
              {t('runExists.release')}
            </button>
          )}
        </>
      }
    >
      {runs.length === 0 && <p style={{ margin: 0 }}>{t('err.RUN_EXISTS')}</p>}
      <ul className="list-plain">
        {runs.map((r) => (
          <li key={r.job}>{runExistsLine(t, r)}</li>
        ))}
      </ul>
    </Dialog>
  );
}
