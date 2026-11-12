// Small building blocks shared by the driver screens: top bar with the sync pill, fixed bottom bar,
// bottom sheet, truck-plate picker, route header and the job status line.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { isApiError, type RouteType, type RunStatus } from '../api';
import { useI18n } from '../i18n';
import { rcStyle } from '../ui/palette';
import { TypeTag } from '../ui/Chip';
import { useErrorText } from '../ui/Feedback';
import { useDriver } from './driverContext';

/** "8 stops" / "1 stop". */
export function stopsText(t: (k: string, v?: Record<string, string | number>) => string, n: number): string {
  return n === 1 ? t('driver.stop1') : t('driver.stops', { n });
}

/** Local HH:MM of a local timestamp (display only: "Synced 10:14"). */
export function hhmm(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Synced 10:14" / "2 unsent" / "Offline · data from 10:12" (§9.3 S1). */
export function SyncPill({ at, cached }: { at?: number; cached?: boolean }) {
  const { t } = useI18n();
  const { online, entries, failing, lastSentAt } = useDriver();
  if (!online) {
    return (
      <span className="pill off" data-testid="sync-pill" role="status">
        {at ? t('driver.sync.offlineFrom', { time: hhmm(at) }) : t('driver.sync.offline')}
      </span>
    );
  }
  if (cached && at) {
    // the phone's copy: the server has not answered yet (or cannot be reached)
    return (
      <span className="pill warn" data-testid="sync-pill" role="status">
        {t('driver.sync.dataFrom', { time: hhmm(at) })}
      </span>
    );
  }
  if (entries.length) {
    return (
      <span className="pill warn" data-testid="sync-pill" role="status">
        {t('driver.sync.unsent', { n: entries.length })}
        {failing ? ' · ' + t('driver.sync.retrying') : ''}
      </span>
    );
  }
  const last = Math.max(at ?? 0, lastSentAt ?? 0);
  return (
    <span className="pill ok" data-testid="sync-pill" role="status">
      {t('driver.sync.synced', { time: hhmm(last || Date.now()) })}
    </span>
  );
}

export function TopBar(props: { back?: string; backLabel?: string; title: ReactNode; sub?: ReactNode; at?: number; cached?: boolean; right?: ReactNode; below?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="drv-top">
      <div className="drv-top-in">
        {props.back && (
          <Link className="back" to={props.back}>
            ‹ {props.backLabel ?? t('driver.back')}
          </Link>
        )}
        <div className="title">
          <b>{props.title}</b>
          {props.sub && <span>{props.sub}</span>}
        </div>
        {props.right}
      </div>
      <div className="drv-top-sub">
        <SyncPill at={props.at} cached={props.cached} />
      </div>
      {props.below}
    </header>
  );
}

/** Primary buttons fixed at the bottom (§9.3). The page adds class has-bar to keep content above it. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="drv-bar">
      <div className="drv-bar-in">{children}</div>
    </div>
  );
}

/** A bottom sheet with a scrim; Esc and the scrim close it unless `busy`. */
export function Sheet({ open, title, onClose, children, busy, testId }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; busy?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  return createPortal(
    <>
      <div className="dsheet-scrim" onClick={busy ? undefined : onClose} />
      <div className="dsheet" role="dialog" aria-modal="true" ref={ref} tabIndex={-1} data-testid={testId}>
        <div className="dsheet-in">
          <h2>{title}</h2>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Truck plate from the office's active vehicle list (R23); no free text. */
export function PlatePicker({ trucks, value, onChange }: { trucks: string[]; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  if (!trucks.length) return <div className="dban warn">{t('driver.plate.none')}</div>;
  return (
    <label className="dfield">
      <span>{t('driver.plate.label')}</span>
      <select name="plate" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('driver.plate.pick')}</option>
        {trucks.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Route code with the colour bar, type tag and name (the big header of S2 / S3). */
export function RouteHead({ code, color, type, name, children }: { code: string | null; color: number | null; type: RouteType | null; name: string | null; children?: ReactNode }) {
  return (
    <div className="rhead" style={rcStyle(color) as CSSProperties}>
      <span className="bar" />
      <div className="rb">
        <div className="row">
          <span className="jcode">
            {type === 'adhoc' ? '⚡' : ''}
            {code}
          </span>
          {type && <TypeTag type={type} />}
          <span className="jname" style={{ fontWeight: 700 }}>
            {name}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The driver's words for a job status (§7.1): Available / Mine / Taken by X / Needs driver / Done. */
export function statusText(
  t: (k: string, v?: Record<string, string | number>) => string,
  status: RunStatus | null,
  opts: { mine: boolean; driver?: string | null; resolved?: number; total?: number; leftBy?: string | null; byOffice?: boolean; kind: 'route' | 'task' },
): string {
  const count = opts.kind === 'route' && opts.total ? ` ${opts.resolved ?? 0}/${opts.total}` : '';
  switch (status) {
    case 'not_started':
      return '○ ' + t('driver.st.available');
    case 'open':
      return (
        '⇄ ' +
        t('driver.st.open') +
        count +
        (opts.leftBy ? ' · ' + t('driver.st.leftBy', { name: opts.leftBy }) : opts.byOffice ? ' · ' + t('driver.st.byOffice') : '')
      );
    case 'active':
      return '◑ ' + (opts.mine ? t('driver.st.mine') : opts.driver || t('driver.st.taken')) + count;
    case 'done':
      return '✓ ' + t('driver.st.done') + count;
    default:
      return status ? t('status.' + status) : '';
  }
}

/** A job that cannot be shown: the day closed (NOT_TODAY), it was removed, or no signal and no copy. */
export function JobProblem({ error }: { error: unknown }) {
  const { t } = useI18n();
  const errText = useErrorText();
  const text = isApiError(error, 'NOT_TODAY') ? t('driver.job.dayClosed') : isApiError(error, 'NOT_FOUND') ? t('driver.job.gone') : errText(error);
  return (
    <div className="drv-main">
      <div className="dban warn" role="alert">
        {text}
      </div>
      <Link className="dbtn primary" to="/driver">
        {t('driver.backToToday')}
      </Link>
    </div>
  );
}
