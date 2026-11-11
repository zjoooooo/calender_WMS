// /driver/job/:date/:job — one job, shown by its state:
//   route: mine with a plate, or done -> Run (S3); otherwise the preview (S2, also the plate step of a
//          job the office assigned to me)
//   task:  mine with a plate, or done -> the result form (S4 for the task); otherwise the preview (S2T)
// /driver/job/:date/:job/stop/:cid[?notsent=<id>] — the result form of one route stop (S4). It keeps the
// last loaded job, so an open form stays usable after the rollover or with no signal (§8.4).
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { driverRelease, isApiError, type JobDetail, type JobStop } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { useErrorText, Loading } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useDriver } from './driverContext';
import { clearSelfRelease, isSelfRelease, localEntries, markSelfRelease, nextPendingStop, refreshDriver, typeMap, useJob, useToday, type Loaded } from './data';
import type { NotSentEntry } from './outbox';
import { JobProblem, Sheet, TopBar } from './parts';
import ResultForm from './ResultForm';
import RoutePreview from './RoutePreview';
import Run from './Run';
import TaskPreview from './TaskPreview';

function useMaxPhotos(): number {
  return useSession().meta?.config.max_photos ?? 5;
}

export default function JobPage() {
  const { date = '', job = '' } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const q = useJob(date, job);
  const today = useToday();
  const td = today.data?.data;

  // The office released or reassigned my job (§8.2): say so and go back to Today.
  const prevMine = useRef<boolean | null>(null);
  useEffect(() => {
    const d = q.data;
    if (!d || d.cached) return;
    const j = d.data;
    if (prevMine.current && !j.mine && !isSelfRelease(j.date, j.job)) {
      const what = j.kind === 'route' ? j.code ?? '' : j.stops[0]?.customer.name ?? '';
      toast(j.holder ? t('driver.toast.movedTo', { code: what, name: j.holder.name }) : t('driver.toast.tookBack', { code: what }), 'warn', 6000);
      nav('/driver', { replace: true });
    }
    prevMine.current = j.mine;
  }, [q.data, nav, t, toast]);

  const hardError = q.isError && (isApiError(q.error, 'NOT_TODAY') || isApiError(q.error, 'NOT_FOUND') || isApiError(q.error, 'VALIDATION'));
  if (hardError || (!q.data && q.error)) {
    return (
      <div className="drv">
        <TopBar back="/driver" title={t('driver.title')} />
        <JobProblem error={q.error} />
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="drv">
        <TopBar back="/driver" title={t('driver.title')} />
        <main className="drv-main">
          <Loading />
        </main>
      </div>
    );
  }
  const j = q.data.data;
  if (j.kind === 'route') {
    if ((j.mine && j.vehicle_no) || j.status === 'done') return <Run loaded={q.data} today={td} />;
    return <RoutePreview loaded={q.data} today={td} />;
  }
  if ((j.mine && j.vehicle_no) || j.status === 'done') return <TaskJob loaded={q.data} />;
  return <TaskPreview loaded={q.data} today={td} />;
}

/** S4 for a task: one weight field for the task's type; after the save, back to Today. */
function TaskJob({ loaded }: { loaded: Loaded<JobDetail> }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const { online, entries } = useDriver();
  const today = useToday();
  const maxPhotos = useMaxPhotos();
  const job = loaded.data;
  const stop = job.stops[0];
  const types = typeMap(today.data?.data.waste_types);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!stop) return <JobProblem error={null} />;
  const saved = stop.visit?.outcome != null || localEntries(entries, job.date, job.job).size > 0;
  const label = types[job.waste_type ?? '']?.abbr || job.waste_type || '';

  const giveBack = async () => {
    setBusy(true);
    setError(null);
    try {
      markSelfRelease(job.date, job.job);
      await driverRelease(job.date, job.job, { mark_missed: false });
      void refreshDriver(qc);
      toast(t('driver.toast.gaveBack', { code: `${label} · ${stop.customer.name}` }));
      nav('/driver', { replace: true });
    } catch (e) {
      clearSelfRelease(job.date, job.job);
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <ResultForm
        key={`${job.date}/${job.job}`}
        date={job.date}
        job={job.job}
        kind="task"
        jobLabel={label}
        stop={stop}
        wasteTypes={types}
        maxPhotos={maxPhotos}
        backTo="/driver"
        at={loaded.at}
        cached={loaded.cached}
        afterSave={() => nav('/driver', { replace: true })}
        menu={
          job.mine && !saved ? (
            <button type="button" className="menu-btn" onClick={() => setMenu(true)}>
              {t('driver.more')}
            </button>
          ) : null
        }
      />
      <Sheet open={menu} title={t('driver.more')} onClose={() => setMenu(false)} busy={busy}>
        <button type="button" className="dbtn" disabled={!online || busy} onClick={() => void giveBack()}>
          {online ? t('driver.task.giveBack') : t('driver.needsSignal')}
        </button>
        {error && (
          <div className="form-err" role="alert">
            {error}
          </div>
        )}
        <button type="button" className="dbtn" onClick={() => setMenu(false)}>
          {t('common.cancel')}
        </button>
      </Sheet>
    </>
  );
}

/** A stop made from a Not sent entry when the job cannot be loaded any more (e.g. after the rollover). */
function stopFromEntry(e: NotSentEntry): JobStop {
  return {
    seq: 1,
    on_plan: true,
    stop_note: '',
    customer: { id: e.customer_id, code: '', name: e.label.customer, address: '', phone: '', note: '' },
    weigh_types: e.label.weigh_types,
    ticket_types: e.label.ticket_types,
    also_on: [],
    visit: null,
  };
}

export function StopPage() {
  const { date = '', job = '', cid = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { t } = useI18n();
  const { me, entries, notsent } = useDriver();
  const maxPhotos = useMaxPhotos();
  const today = useToday();
  const q = useJob(date, job);
  const last = useRef<Loaded<JobDetail> | null>(null);
  if (q.data) last.current = q.data;
  const loaded = q.data ?? last.current;
  const customerId = Number(cid);
  const ns = params.get('notsent') ? notsent.find((e) => e.id === params.get('notsent')) ?? null : null;
  const types = typeMap(today.data?.data.waste_types);
  const j = loaded?.data;
  const stop = j?.stops.find((s) => s.customer.id === customerId) ?? (ns ? stopFromEntry(ns) : null);

  if (!stop) {
    if (!loaded && !q.error) {
      return (
        <div className="drv">
          <TopBar back={`/driver/job/${date}/${job}`} title={t('driver.title')} />
          <main className="drv-main">
            <Loading />
          </main>
        </div>
      );
    }
    return (
      <div className="drv">
        <TopBar back="/driver" title={t('driver.title')} />
        <JobProblem error={q.error ?? new Error('NOT_ON_JOB')} />
      </div>
    );
  }

  const kind = j?.kind ?? (job.startsWith('t') ? 'task' : 'route');
  const jobLabel = ns?.label.job_label ?? (kind === 'route' ? (j?.type === 'adhoc' ? '⚡' : '') + (j?.code ?? '') : types[j?.waste_type ?? '']?.abbr || j?.waste_type || '');
  const runUrl = `/driver/job/${date}/${job}`;

  return (
    <ResultForm
      key={`${date}/${job}/${customerId}/${ns?.id ?? ''}`}
      date={date}
      job={job}
      kind={kind}
      jobLabel={jobLabel}
      stop={stop}
      wasteTypes={types}
      maxPhotos={maxPhotos}
      backTo={ns ? '/driver/notsent' : kind === 'task' ? '/driver' : runUrl}
      notsent={ns}
      at={loaded?.at}
      cached={loaded?.cached}
      afterSave={(outcome) => {
        if (ns) return nav('/driver/notsent', { replace: true });
        if (kind === 'task') return nav('/driver', { replace: true });
        if (outcome === null || !j) return nav(runUrl, { replace: true });
        // Collected / not collected: straight to the next pending stop (§7.3 step 5).
        const next = nextPendingStop(j, localEntries(entries, date, job), me.id, customerId, [customerId]);
        nav(next ? `${runUrl}/stop/${next.customer.id}` : runUrl, { replace: true });
      }}
    />
  );
}
