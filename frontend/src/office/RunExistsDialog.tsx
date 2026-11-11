// "Blocked by a run" dialog (R26, §6.11). Shown when a write returns 409 RUN_EXISTS
// {runs:[{job, code_or_customer, driver, resolved}]}.
// - Nothing done yet (every resolved = 0): "Ali has N1 (0 done). [Release the driver and continue]";
//   the caller resends the same write with release_run = true.
// - Work done: "Refused: Ali has done 3 on N1 …" and only Close.
// Reusable by every office write that can hit R26 (customers, holidays, routes, tasks).
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

export function RunExistsDialog(props: { error: ApiError | null; busy?: boolean; onRelease: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const runs = blockingRuns(props.error);
  const canRelease = runs.length > 0 && runs.every((r) => !r.resolved);
  const driver = (r: BlockingRun) => r.driver || t('runExists.nobody');
  return (
    <Dialog
      open={!!props.error}
      title={t('runExists.title')}
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
          <li key={r.job}>
            {r.resolved
              ? t('runExists.refused', { driver: driver(r), what: r.code_or_customer, resolved: r.resolved })
              : t('runExists.noneDone', { driver: driver(r), what: r.code_or_customer })}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
