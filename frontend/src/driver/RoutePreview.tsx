// S2 Route preview (= select, §9.3): code, name, note, a read-only stop list and the truck plate
// (pre-filled with this phone's last plate). [Confirm: I take this route]; while holding another route
// it reads [Switch to this route] and opens the Switch sheet (§7.5). Offline: "Needs signal".
// A job the office assigned to me without a plate also lands here: confirming the plate is a claim
// that returns 200 (R24).
import { useEffect, useState } from 'react';
import type { DriverToday, JobDetail } from '../api';
import { useI18n } from '../i18n';
import { draftsOfJob } from './cache';
import { lastPlate, useClaim, type ActiveRun } from './claim';
import { useDriver } from './driverContext';
import type { Loaded } from './data';
import { SwitchSheet } from './LeaveSheet';
import { BottomBar, PlatePicker, RouteHead, statusText, stopsText, TopBar } from './parts';

export default function RoutePreview({ loaded, today }: { loaded: Loaded<JobDetail>; today: DriverToday | undefined }) {
  const { t } = useI18n();
  const { me, online } = useDriver();
  const job = loaded.data;
  const trucks = today?.trucks ?? [];
  const [plate, setPlate] = useState(() => job.vehicle_no ?? lastPlate(trucks));
  useEffect(() => {
    if (!plate && trucks.length) setPlate(lastPlate(trucks));
  }, [trucks.join(',')]);

  const mr = today?.my_route;
  const heldOther: ActiveRun | null = mr && mr.job !== job.job && mr.pending > 0 ? { job: mr.job, code: mr.code, pending: mr.pending } : null;
  const [switchFrom, setSwitchFrom] = useState<(ActiveRun & { total: number }) | null>(null);
  const [drafts, setDrafts] = useState(0);
  const openSwitch = (other: ActiveRun) => {
    const total = mr && mr.job === other.job ? mr.total : other.pending;
    setSwitchFrom({ ...other, total });
    void draftsOfJob(me.id, job.date, other.job).then((d) => setDrafts(d.length));
  };
  const { claim, busy, error, setError } = useClaim(job, openSwitch);

  const assigned = job.mine && !job.vehicle_no;
  const takenBy = job.status === 'active' && !job.mine ? job.holder?.name ?? '' : null;
  const runnable = (job.status === 'not_started' || job.status === 'open' || job.mine) && job.progress.pending > 0;
  const toLabel = (job.type === 'adhoc' ? '⚡' : '') + (job.code ?? '');

  const confirm = () => {
    if (!plate) return setError(t('err.VEHICLE_REQUIRED'));
    if (heldOther && !assigned) return openSwitch(heldOther);
    void claim(plate, null);
  };

  let label = t('driver.preview.confirmRoute');
  if (assigned) label = t('driver.preview.confirmPlate');
  else if (heldOther) label = t('driver.preview.switchTo');
  if (!online) label = t('driver.needsSignal');

  return (
    <div className="drv has-bar">
      <TopBar back="/driver" title={toLabel} sub={job.name ?? ''} at={loaded.at} cached={loaded.cached} />
      <main className="drv-main">
        <RouteHead code={job.code} color={job.color} type={job.type} name={job.name}>
          <div className="meta">
            {stopsText(t, job.progress.total)}
            {job.status ? ' · ' + statusText(t, job.status, { mine: job.mine, driver: job.holder?.name, resolved: job.progress.total - job.progress.pending, total: job.progress.total }) : ''}
          </div>
          {job.note && <div>{job.note}</div>}
        </RouteHead>
        {assigned && <div className="dban info">{t('driver.preview.assigned')}</div>}
        {takenBy !== null && <div className="dban warn">{t('driver.preview.takenBy', { name: takenBy })}</div>}
        {!runnable && takenBy === null && <div className="dban warn">{t('driver.preview.notRunnable')}</div>}
        <div className="mini" data-testid="preview-stops">
          {job.stops
            .filter((s) => s.on_plan)
            .map((s) => (
              <div key={s.customer.id}>
                <span className="s">{s.seq}</span>
                {s.visit?.outcome ? <span className="d">✓</span> : null}
                <b>{s.customer.name}</b>
                <div className="meta" style={{ marginLeft: 32 }}>
                  {s.customer.address}
                  {s.stop_note ? ' · ' + s.stop_note : ''}
                </div>
              </div>
            ))}
        </div>
        <PlatePicker trucks={trucks} value={plate} onChange={setPlate} />
        {error && (
          <div className="form-err" role="alert" data-testid="claim-error">
            {error}
          </div>
        )}
      </main>
      <BottomBar>
        <button type="button" className="dbtn primary big" data-testid="confirm" disabled={!online || busy || !runnable || takenBy !== null || !trucks.length} onClick={confirm}>
          {label}
        </button>
      </BottomBar>
      {switchFrom && (
        <SwitchSheet
          open
          from={switchFrom}
          toLabel={toLabel}
          drafts={drafts}
          busy={busy}
          error={error}
          onConfirm={async () => {
            if (await claim(plate, switchFrom)) setSwitchFrom(null);
          }}
          onClose={() => setSwitchFrom(null)}
        />
      )}
    </div>
  );
}
