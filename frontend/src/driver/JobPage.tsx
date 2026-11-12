// /driver/job/:date/:job — one job, shown by its state:
//   mine with a plate, or done -> Run (S3); otherwise the preview (S2, also the plate step of a job the
//   office assigned to me)
// /driver/job/:date/:job/stop/:cid[?notsent=<id>] — the result form of one route stop (S4). It keeps the
// last loaded job, so an open form stays usable after the rollover or with no signal (§8.4).
// Both watch the job: when the office releases or reassigns it (§8.2), the phone says so and returns to
// Today, also from a stop form (which moves from stop to stop without passing through the run view).
import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { isApiError, type JobDetail, type JobStop } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Loading } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { useDriver } from './driverContext';
import { isSelfRelease, localEntries, nextPendingStop, typeMap, useJob, useToday, type Loaded } from './data';
import type { NotSentEntry } from './outbox';
import { JobProblem, TopBar } from './parts';
import ResultForm from './ResultForm';
import RoutePreview from './RoutePreview';
import Run from './Run';

function useMaxPhotos(): number {
  return useSession().meta?.config.max_photos ?? 5;
}

/** The office released or reassigned my job (§8.2): say so and go back to Today. */
function useOfficeTookJob(data: Loaded<JobDetail> | undefined): void {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const prevMine = useRef<boolean | null>(null);
  useEffect(() => {
    const d = data;
    if (!d || d.cached) return;
    const j = d.data;
    if (prevMine.current && !j.mine && !isSelfRelease(j.date, j.job)) {
      const what = j.code;
      toast(j.holder ? t('driver.toast.movedTo', { code: what, name: j.holder.name }) : t('driver.toast.tookBack', { code: what }), 'warn', 6000);
      nav('/driver', { replace: true });
    }
    prevMine.current = j.mine;
  }, [data, nav, t, toast]);
}

export default function JobPage() {
  const { date = '', job = '' } = useParams();
  const { t } = useI18n();
  const q = useJob(date, job);
  const today = useToday();
  const td = today.data?.data;
  useOfficeTookJob(q.data);

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
  if ((j.mine && j.vehicle_no) || j.status === 'done') return <Run loaded={q.data} today={td} />;
  return <RoutePreview loaded={q.data} today={td} />;
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
  const { me, entries, notsent, ready } = useDriver();
  const maxPhotos = useMaxPhotos();
  const today = useToday();
  const q = useJob(date, job);
  useOfficeTookJob(q.data);
  const last = useRef<Loaded<JobDetail> | null>(null);
  if (q.data) last.current = q.data;
  const loaded = q.data ?? last.current;
  const customerId = Number(cid);
  const ns = params.get('notsent') ? notsent.find((e) => e.id === params.get('notsent')) ?? null : null;
  const types = typeMap(today.data?.data.waste_types);
  const j = loaded?.data;
  const stop = j?.stops.find((s) => s.customer.id === customerId) ?? (ns ? stopFromEntry(ns) : null);

  if (!stop || !ready) {
    // Before the outbox is read, a ?notsent= entry is not known yet: wait instead of "not on this job".
    if ((!loaded && !q.error) || !ready) {
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

  const jobLabel = ns?.label.job_label ?? (j?.type === 'adhoc' ? '⚡' : '') + (j?.code ?? '');
  const runUrl = `/driver/job/${date}/${job}`;

  return (
    <ResultForm
      key={`${date}/${job}/${customerId}/${ns?.id ?? ''}`}
      date={date}
      job={job}
      kind="route"
      jobLabel={jobLabel}
      stop={stop}
      wasteTypes={types}
      maxPhotos={maxPhotos}
      backTo={ns ? '/driver/notsent' : runUrl}
      notsent={ns}
      at={loaded?.at}
      cached={loaded?.cached}
      afterSave={(outcome) => {
        if (ns) return nav('/driver/notsent', { replace: true });
        // Not mine any more (the office took it back; the hook above says so): no auto-advance.
        const latest = q.data && !q.data.cached ? q.data.data : j;
        if (outcome === null || !j || !latest?.mine) return nav(runUrl, { replace: true });
        // Collected / not collected: straight to the next pending stop (§7.3 step 5).
        const next = nextPendingStop(j, localEntries(entries, date, job), me.id, customerId, [customerId]);
        nav(next ? `${runUrl}/stop/${next.customer.id}` : runUrl, { replace: true });
      }}
    />
  );
}
