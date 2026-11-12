// S2T Task preview (§9.3): type, customer, address, [Navigate] [Call], the note and the plate (pre-filled
// with the plate of the driver's current route, else this phone's last plate). [Confirm: I take this
// task] works while the driver holds a route (tasks never conflict, R23).
import { useState } from 'react';
import type { DriverToday, JobDetail } from '../api';
import { useI18n } from '../i18n';
import { WasteTag } from '../ui/Chip';
import { lastPlate, useClaim } from './claim';
import { useDriver } from './driverContext';
import type { Loaded } from './data';
import { BottomBar, PlatePicker, statusText, TopBar } from './parts';
import { ContactLinks } from './ResultForm';

export default function TaskPreview({ loaded, today }: { loaded: Loaded<JobDetail>; today: DriverToday | undefined }) {
  const { t } = useI18n();
  const { online } = useDriver();
  const job = loaded.data;
  const stop = job.stops[0];
  const trucks = today?.trucks ?? [];
  const routePlate = today?.my_route?.vehicle_no ?? '';
  const [plate, setPlate] = useState(() => job.vehicle_no ?? (routePlate && trucks.includes(routePlate) ? routePlate : lastPlate(trucks)));
  const { claim, busy, error, setError } = useClaim(job, () => undefined);
  const abbr = today?.waste_types.find((w) => w.code === job.waste_type)?.abbr;
  const assigned = job.mine && !job.vehicle_no;
  const takenBy = job.status === 'active' && !job.mine ? job.holder?.name ?? '' : null;
  const runnable = (job.status === 'not_started' || job.status === 'open' || job.mine) && job.progress.pending > 0;

  const confirm = () => {
    if (!plate) return setError(t('err.VEHICLE_REQUIRED'));
    void claim(plate, null);
  };

  return (
    <div className="drv has-bar">
      <TopBar back="/driver" title={`${abbr ?? job.waste_type ?? ''} · ${stop?.customer.name ?? ''}`} at={loaded.at} cached={loaded.cached} />
      <main className="drv-main">
        <div className="cust stack">
          <div className="row">
            <WasteTag code={job.waste_type ?? ''} abbr={abbr} />
            <span className="meta">{statusText(t, job.status, { mine: job.mine, driver: job.holder?.name, kind: 'task' })}</span>
          </div>
          <h1>{stop?.customer.name}</h1>
          <div>{stop?.customer.address}</div>
          {stop && <ContactLinks address={stop.customer.address} phone={stop.customer.phone} />}
          {job.note && <div className="dban info">{job.note}</div>}
          {stop?.customer.note && <div className="meta">{stop.customer.note}</div>}
          {stop?.also_on.map((a) => (
            <div key={a.job} className="meta">
              {t('driver.alsoOn', { what: a.label })}
            </div>
          ))}
        </div>
        {assigned && <div className="dban info">{t('driver.preview.assigned')}</div>}
        {takenBy !== null && <div className="dban warn">{t('driver.preview.takenBy', { name: takenBy })}</div>}
        {!runnable && takenBy === null && <div className="dban warn">{t('driver.preview.notRunnable')}</div>}
        <PlatePicker trucks={trucks} value={plate} onChange={setPlate} />
        {error && (
          <div className="form-err" role="alert" data-testid="claim-error">
            {error}
          </div>
        )}
      </main>
      <BottomBar>
        <button type="button" className="dbtn primary big" data-testid="confirm" disabled={!online || busy || !runnable || takenBy !== null || !trucks.length} onClick={confirm}>
          {!online ? t('driver.needsSignal') : assigned ? t('driver.preview.confirmPlate') : t('driver.preview.confirmTask')}
        </button>
      </BottomBar>
    </div>
  );
}
