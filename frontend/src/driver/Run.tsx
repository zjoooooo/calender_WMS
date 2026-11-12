// S3 Run (route, §9.3): code, progress "3 / 8" and the totals per type; pending stops as large cards in
// seq order (NEW badge, "also on …", only routable type tags); a collapsible Done list (✓ / ✗, weights,
// a cloud mark while unsent). [Finish route] when pending = 0; otherwise the overflow menu has
// [Leave route…] (S5) and [⇄ Switch route] (§7.5). Server state is merged with the phone's unsent
// results. Office actions show up on the next poll: a new stop gets NEW, a removed one a toast, and a
// release / reassign sends the driver back to Today (§8.2).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { driverRelease, prefs, type DriverToday, type JobDetail, type MissReason } from '../api';
import { fmtWeight, useI18n } from '../i18n';
import { WasteTag } from '../ui/Chip';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useDriver } from './driverContext';
import { clearSelfRelease, effectiveVisit, localEntries, markSelfRelease, mergedProgress, nextPendingStop, refreshDriver, typeMap, type Loaded } from './data';
import { LeaveSheet } from './LeaveSheet';
import { BottomBar, RouteHead, Sheet, TopBar } from './parts';

export function totalsText(totals: Record<string, number>, types: ReturnType<typeof typeMap>): string {
  return Object.entries(totals)
    .map(([c, kg]) => `${types[c]?.abbr || c} ${fmtWeight(kg)} ${types[c]?.unit || 'kg'}`)
    .join(' · ');
}

export default function Run({ loaded, today }: { loaded: Loaded<JobDetail>; today: DriverToday | undefined }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const { me, entries, online, flushNow } = useDriver();
  const job = loaded.data;
  const types = typeMap(today?.waste_types);
  const local = useMemo(() => localEntries(entries, job.date, job.job), [entries, job.date, job.job]);
  const prog = mergedProgress(job, local, me.id);
  const readOnly = !job.mine;
  const base = `/driver/job/${job.date}/${job.job}`;

  const pending = job.stops.filter((s) => s.on_plan && effectiveVisit(s, local.get(s.customer.id), me.id)?.outcome == null);
  const done = job.stops.filter((s) => effectiveVisit(s, local.get(s.customer.id), me.id)?.outcome != null);
  const unsentHere = local.size;

  // NEW badge (§8.2): stops this phone had not seen in this job before.
  const seenKey = `driver.seenStops.${me.id}.${job.date}.${job.job}`;
  const [seen, setSeen] = useState<number[] | null>(null);
  useEffect(() => {
    const ids = job.stops.map((s) => s.customer.id);
    const raw = prefs.get(seenKey);
    if (raw === null) {
      prefs.set(seenKey, JSON.stringify(ids));
      setSeen(ids);
    } else {
      try {
        setSeen(JSON.parse(raw));
      } catch {
        setSeen(ids);
      }
    }
  }, [seenKey]);
  const markSeen = (cid: number) => {
    if (!seen || seen.includes(cid)) return;
    const next = [...seen, cid];
    prefs.set(seenKey, JSON.stringify(next));
    setSeen(next);
  };

  // Stops the office removed (§8.2), detected between two polls. (A release or reassign by the office is
  // handled by JobPage, which stays mounted when this view turns into the preview.)
  const prev = useRef<Map<number, string> | null>(null);
  useEffect(() => {
    if (loaded.cached) return;
    const p = prev.current;
    if (p) {
      for (const [cid, name] of p) {
        if (!job.stops.some((s) => s.customer.id === cid)) toast(t('driver.toast.removed', { customer: name }), 'warn', 5000);
      }
    }
    prev.current = new Map(pending.map((s) => [s.customer.id, s.customer.name] as [number, string]));
  }, [loaded]);

  const [showDone, setShowDone] = useState(true);
  const [more, setMore] = useState(false);
  const [leave, setLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leave / finish first send this job's unsent results (otherwise the server still sees those stops as pending).
  const release = async (body: { mark_missed: boolean; reason?: MissReason; note?: string }, then: 'today' | 'done') => {
    setBusy(true);
    setError(null);
    try {
      if (unsentHere) {
        const r = await flushNow();
        if (r.remaining > 0 || r.stopped) {
          setError(t('driver.run.sendFirst', { n: r.remaining || unsentHere }));
          return;
        }
      }
      markSelfRelease(job.date, job.job);
      const r = await driverRelease(job.date, job.job, body);
      // The server's new copy first: otherwise S6 shows the job as it was before (for example "6 stops still to
      // do" after "Mark all not collected") for one round trip, longer on 4G. Driver queries do not retry.
      await refreshDriver(qc);
      setLeave(false);
      if (then === 'done' || r.result === 'done') nav(`${base}/done`, { replace: true });
      else {
        toast(t('driver.toast.gaveBack', { code: job.code ?? '' }));
        nav('/driver', { replace: true });
      }
    } catch (e) {
      clearSelfRelease(job.date, job.job);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const next = nextPendingStop(job, local, me.id, null);
  const stopUrl = (cid: number) => `${base}/stop/${cid}`;

  return (
    <div className="drv has-bar">
      <TopBar
        back="/driver"
        title={(job.type === 'adhoc' ? '⚡' : '') + (job.code ?? '')}
        sub={job.vehicle_no ?? ''}
        at={loaded.at}
        cached={loaded.cached}
        right={
          !readOnly ? (
            <button type="button" className="menu-btn" onClick={() => setMore(true)}>
              {t('driver.more')}
            </button>
          ) : null
        }
      />
      <main className="drv-main" data-testid="run">
        <RouteHead code={job.code} color={job.color} type={job.type} name={job.name}>
          <div className="prog" data-testid="progress">
            {prog.collected + prog.missed} / {prog.total}
          </div>
          {Object.keys(prog.totals).length > 0 && <div className="totals">{totalsText(prog.totals, types)}</div>}
          {job.note && <div className="meta">{job.note}</div>}
        </RouteHead>
        {readOnly && <div className="dban info">{job.status === 'done' ? t('driver.run.doneReadOnly') : t('driver.run.notMine')}</div>}
        {error && (
          <div className="form-err" role="alert">
            {error}
          </div>
        )}

        {pending.length > 0 && <div className="sec">{t('driver.run.pending', { n: pending.length })}</div>}
        {pending.map((s) => {
          const isNew = !!seen && !seen.includes(s.customer.id);
          const content = (
            <>
              <span className="l1">
                <span className="seq">{s.seq}</span>
                <span className="nm">{s.customer.name}</span>
                {isNew && <span className="newtag">{t('driver.new')}</span>}
              </span>
              <span className="meta">{s.customer.address}</span>
              {s.stop_note && <span>{s.stop_note}</span>}
              <span className="row">
                {s.weigh_types.map((c) => (
                  <WasteTag key={c} code={c} abbr={types[c]?.abbr} />
                ))}
                {s.also_on.map((a) => (
                  <span key={a.job} className="meta">
                    {t('driver.alsoOn', { what: a.label })}
                  </span>
                ))}
              </span>
            </>
          );
          return readOnly ? (
            <div key={s.customer.id} className="scard">
              {content}
            </div>
          ) : (
            <Link key={s.customer.id} className="scard" to={stopUrl(s.customer.id)} data-cid={s.customer.id} onClick={() => markSeen(s.customer.id)}>
              {content}
            </Link>
          );
        })}

        {done.length > 0 && (
          <>
            <button type="button" className="toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              {showDone ? '▾ ' : '▸ '}
              {t('driver.run.done', { n: done.length })}
            </button>
            {showDone && (
              <div className="donelist" data-testid="done-list">
                {done.map((s) => {
                  const v = effectiveVisit(s, local.get(s.customer.id), me.id)!;
                  const canEdit = v.unsent || v.driver_id === me.id;
                  const body = (
                    <>
                      <span className={v.outcome === 'collected' ? 'mk ok' : 'mk miss'}>{v.outcome === 'collected' ? '✓' : '✗'}</span>
                      <span className="grow">
                        <b>{s.customer.name}</b>
                        <br />
                        <span className="meta">
                          {v.outcome === 'collected' ? totalsText(Object.fromEntries(Object.entries(v.weights).map(([k, w]) => [k, Number(w)])), types) : t('driver.reason.' + (v.reason ?? 'other'))}
                        </span>
                      </span>
                      {v.unsent && <span className="unsent">☁ {t('driver.unsent')}</span>}
                    </>
                  );
                  return canEdit && job.date === (today?.today ?? job.date) ? (
                    <Link key={s.customer.id} className="drow" to={stopUrl(s.customer.id)} data-cid={s.customer.id}>
                      {body}
                    </Link>
                  ) : (
                    <div key={s.customer.id} className="drow" data-cid={s.customer.id}>
                      {body}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      <BottomBar>
        {readOnly ? (
          <Link className="dbtn primary big" to="/driver">
            {t('driver.backToToday')}
          </Link>
        ) : prog.pending === 0 ? (
          <button type="button" className="dbtn go big" data-testid="finish" disabled={!online || busy} onClick={() => void release({ mark_missed: false }, 'done')}>
            {!online ? t('driver.needsSignal') : unsentHere ? t('driver.run.sending', { n: unsentHere }) : t('driver.run.finish')}
          </button>
        ) : next ? (
          <Link className="dbtn primary big" to={stopUrl(next.customer.id)} data-testid="next-stop" onClick={() => markSeen(next.customer.id)}>
            {t('driver.run.next', { name: next.customer.name })}
          </Link>
        ) : null}
      </BottomBar>

      <Sheet open={more} title={t('driver.more')} onClose={() => setMore(false)} testId="run-menu">
        <button
          type="button"
          className="dbtn"
          disabled={!online || prog.pending === 0}
          onClick={() => {
            setMore(false);
            setLeave(true);
          }}
        >
          {online ? t('driver.run.leave') : t('driver.needsSignal')}
        </button>
        <button type="button" className="dbtn" disabled={!online} onClick={() => nav('/driver?switch=1')}>
          {online ? t('driver.run.switch') : t('driver.needsSignal')}
        </button>
        <button type="button" className="dbtn" onClick={() => setMore(false)}>
          {t('common.cancel')}
        </button>
      </Sheet>

      <LeaveSheet
        open={leave}
        pending={prog.pending}
        busy={busy}
        error={error}
        onGiveBack={() => void release({ mark_missed: false }, 'today')}
        onMarkAll={(reason, note) => void release({ mark_missed: true, reason, note }, 'done')}
        onClose={() => {
          setLeave(false);
          setError(null);
        }}
      />
    </div>
  );
}
