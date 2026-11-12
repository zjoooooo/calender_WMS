// Free submission of a non-routable waste type (OTC, COMPACTOR, EROSE …). Nothing is planned and nothing
// is claimed: the driver picks the waste type, then a customer registered with it (searchable), then fills
// the same form as a route stop (weight, weighbridge ticket, photos, signature, note) plus the truck plate.
//   /driver/submit               new: type -> customer -> form
//   /driver/submit/:date/:id     change or delete one of my submissions (?notsent=<id>: a refused one)
// The save goes to the outbox like a stop result, so it works with no signal; the record's id is made here
// and its date is the operational date (opDateNow), so a resend never creates a second record.
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SubmitCustomer } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { uuidv4 } from '../ui/uuid';
import { useDriver } from './driverContext';
import { typeMap, useMySubmissions, useSubmitCustomers, useToday } from './data';
import { JobProblem, TopBar } from './parts';
import ResultForm from './ResultForm';
import { opDateNow, subJob, subStop } from './submission';

const MAX_LIST = 50;

/** New submission: type, then customer, then the form. */
export default function SubmitPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const today = useToday();
  const custQ = useSubmitCustomers();
  const maxPhotos = useSession().meta?.config.max_photos ?? 5;
  const td = today.data?.data;
  const types = typeMap(td?.waste_types);
  const free = (td?.waste_types ?? []).filter((w) => !w.routable && w.active);
  const [typeSel, setType] = useState<string | null>(null);
  const type = typeSel ?? (free.length === 1 ? free[0].code : null);
  const [customer, setCustomer] = useState<SubmitCustomer | null>(null);
  const [q, setQ] = useState('');
  // The record's identity, fixed when the form opens: a new id and the operational date at that moment.
  const [id] = useState(uuidv4);
  const [date, setDate] = useState('');

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (custQ.data?.data ?? []).filter(
      (c) => !!type && c.waste_types.includes(type) && (!needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle) || c.address.toLowerCase().includes(needle)),
    );
  }, [custQ.data, type, q]);

  if (!td || !today.data) {
    return (
      <div className="drv">
        <TopBar back="/driver" title={t('driver.submit.title')} />
        <main className="drv-main">{today.error ? <ErrorBanner error={today.error} onRetry={() => void today.refetch()} /> : <Loading />}</main>
      </div>
    );
  }

  if (type && customer && date) {
    return (
      <ResultForm
        key={id}
        date={date}
        job={subJob(id)}
        kind="submission"
        jobLabel={types[type]?.abbr || type}
        submission={{ waste_type: type, trucks: td.trucks, vehicle_no: null }}
        stop={subStop(customer, type, types)}
        wasteTypes={types}
        maxPhotos={maxPhotos}
        backTo="/driver"
        at={today.data.at}
        cached={today.data.cached}
        afterSave={() => nav('/driver', { replace: true })}
      />
    );
  }

  return (
    <div className="drv">
      <TopBar back="/driver" title={t('driver.submit.title')} sub={type ? types[type]?.name ?? type : undefined} at={custQ.data?.at} cached={custQ.data?.cached} />
      <main className="drv-main" data-testid="submit-page">
        {free.length === 0 && <div className="dban warn">{t('driver.submit.noTypes')}</div>}
        <div className="sec">{t('driver.submit.pickType')}</div>
        <div className="dbtns" role="group" aria-label={t('driver.submit.pickType')}>
          {free.map((w) => (
            <button
              key={w.code}
              type="button"
              className={type === w.code ? 'dbtn primary' : 'dbtn'}
              aria-pressed={type === w.code}
              data-type={w.code}
              onClick={() => {
                setType(w.code);
                setCustomer(null);
              }}
            >
              {w.abbr || w.code}
            </button>
          ))}
        </div>

        {type && (
          <>
            <div className="sec">{t('driver.submit.pickCustomer')}</div>
            <label className="dfield">
              <span className="visually-hidden">{t('common.search')}</span>
              <input type="search" name="customer-search" value={q} autoComplete="off" placeholder={t('driver.submit.search')} onChange={(e) => setQ(e.target.value)} />
            </label>
            {!custQ.data && (custQ.error ? <ErrorBanner error={custQ.error} onRetry={() => void custQ.refetch()} /> : <Loading />)}
            {custQ.data && list.length === 0 && <div className="empty">{t('driver.submit.noCustomers', { type: types[type]?.abbr || type })}</div>}
            <div className="stack" data-testid="submit-customers">
              {list.slice(0, MAX_LIST).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="jcard"
                  data-customer={c.id}
                  onClick={() => {
                    setCustomer(c);
                    setDate(opDateNow(td, today.data!.at, Date.now()));
                  }}
                >
                  <span className="bar" />
                  <span className="jb">
                    <span className="jl1">
                      <span className="jname">{c.name}</span>
                      <span className="code">{c.code}</span>
                    </span>
                    {c.address && <span className="jmeta">{c.address}</span>}
                  </span>
                </button>
              ))}
              {list.length > MAX_LIST && <div className="muted">{t('driver.submit.more', { n: list.length - MAX_LIST })}</div>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** One of my submissions: change it, or delete it. */
export function SubmissionPage() {
  const { date = '', id = '' } = useParams();
  const [params] = useSearchParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const { entries, notsent, ready } = useDriver();
  const today = useToday();
  const subsQ = useMySubmissions(date);
  const maxPhotos = useSession().meta?.config.max_photos ?? 5;
  const types = typeMap(today.data?.data.waste_types);
  const job = subJob(id);
  const ns = params.get('notsent') ? notsent.find((e) => e.id === params.get('notsent')) ?? null : null;
  const record = subsQ.data?.data.submissions.find((s) => s.id === id) ?? null;
  const local = [...entries].reverse().find((e) => e.job === job && e.date === date) ?? null;
  const entry = ns ?? local;
  const back = ns ? '/driver/notsent' : '/driver';

  if (!ready || (!record && !entry && !subsQ.data && !subsQ.error)) {
    return (
      <div className="drv">
        <TopBar back={back} title={t('driver.submit.title')} />
        <main className="drv-main">
          <Loading />
        </main>
      </div>
    );
  }
  const type = record?.waste_type ?? entry?.body.waste_type ?? entry?.label.weigh_types[0];
  if (!type || (!record && !entry)) {
    return (
      <div className="drv">
        <TopBar back={back} title={t('driver.submit.title')} />
        <JobProblem error={subsQ.error ?? new Error('NOT_FOUND')} />
      </div>
    );
  }
  const customer = record ? { id: record.customer_id, code: record.customer.code, name: record.customer.name, address: record.customer.address } : { id: entry!.customer_id, name: entry!.label.customer };

  return (
    <ResultForm
      key={`${date}/${id}/${ns?.id ?? ''}`}
      date={date}
      job={job}
      kind="submission"
      jobLabel={types[type]?.abbr || type}
      submission={{ waste_type: type, trucks: today.data?.data.trucks ?? [], vehicle_no: record?.vehicle_no ?? null }}
      stop={subStop(customer, type, types, record)}
      wasteTypes={types}
      maxPhotos={maxPhotos}
      backTo={back}
      notsent={ns}
      at={subsQ.data?.at}
      cached={subsQ.data?.cached}
      afterSave={() => nav(back, { replace: true })}
    />
  );
}
