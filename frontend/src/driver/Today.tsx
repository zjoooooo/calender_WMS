// S1 Today (§7.3, §9.3): the op_date's routes. Top bar with the date (and the night-shift line between
// midnight and the rollover), the driver's name and the sync pill; "My work" (the held route, "Assigned by
// office"); the routes in the sections Needs driver, Available, Taken and Done (each card carries the
// route's waste-type tag); then the free submissions: a [Submit OTC / COMPACTOR / EROSE] button (no plan,
// no claim) and "My submissions today" (the server's list with this phone's unsent ones; tap to change or
// delete). Taken routes are grey and cannot be tapped. Banners: "New today" (only routes still open to
// this driver: not done, not taken by someone else), "Not sent", switch mode.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { prefs, type DriverRouteCard, type DriverToday, type WasteType } from '../api';
import { fmtTime, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { TypeTag, WasteTag } from '../ui/Chip';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { LangSwitch } from '../ui/LangSwitch';
import { rcStyle } from '../ui/palette';
import { useToast } from '../ui/Toast';
import { pruneCache } from './cache';
import { useDriver } from './driverContext';
import { typeMap, useMySubmissions, useToday } from './data';
import { Sheet, statusText, stopsText, TopBar } from './parts';
import { mergeSubmissions } from './submission';

const SECTIONS = ['open', 'not_started', 'active', 'done'] as const;

const driverName = (d: DriverRouteCard['driver']): string | null => (d == null ? null : typeof d === 'string' ? d : d.name);
const driverId = (d: DriverRouteCard['driver']): number | null => (d && typeof d === 'object' ? d.id : null);

/** Last op_date seen per user in this page load (for the "Day closed" toast, §8.4). */
const lastToday = new Map<number, string>();

export default function Today() {
  const { t, day } = useI18n();
  const s = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const { me, notsent, entries } = useDriver();
  const q = useToday();
  const [params, setParams] = useSearchParams();
  const switching = params.get('switch') === '1';
  const [menu, setMenu] = useState(false);
  const [logoutRefused, setLogoutRefused] = useState(false);
  const data = q.data?.data;

  useEffect(() => {
    document.title = `${t('driver.title')} · WMS`;
  }, [t]);

  // Rollover (§8.4): drop the old day's cached jobs and say so. The session already refetched everything.
  useEffect(() => {
    if (!data?.today || q.data?.cached) return;
    const prev = lastToday.get(me.id);
    lastToday.set(me.id, data.today);
    if (prev && prev !== data.today) {
      void pruneCache(me.id, data.today);
      const time = s.meta?.day_ends_at ? fmtTime(s.meta.day_ends_at) : '';
      toast(t('driver.dayClosed', { time, day: day(data.today) }), 'info', 6000);
    }
  }, [data?.today, q.data?.cached, me.id, s.meta?.day_ends_at, t, day, toast]);

  // "New today" (§8.4): job keys not in the last copy this phone has seen.
  const seenKey = data ? `driver.seen.${me.id}.${data.today}` : '';
  const jobKeys = useMemo(() => (data ? data.routes.map((r) => r.job) : []), [data]);
  const [seen, setSeen] = useState<string[] | null>(null);
  useEffect(() => {
    if (!seenKey) return;
    const raw = prefs.get(seenKey);
    if (raw === null) {
      prefs.set(seenKey, JSON.stringify(jobKeys));
      setSeen(jobKeys);
    } else {
      try {
        setSeen(JSON.parse(raw));
      } catch {
        setSeen(jobKeys);
      }
    }
  }, [seenKey]);
  // Only jobs this driver can still act on: not done, and not taken by someone else (DRV: no stale news).
  const actionable = useMemo(() => {
    const ok = (status: string, holder: number | null) => status === 'planned' || status === 'not_started' || status === 'open' || (status === 'active' && holder === me.id);
    return new Set((data?.routes ?? []).filter((r) => ok(r.status, driverId(r.driver))).map((r) => r.job));
  }, [data, me.id]);
  const fresh = seen ? jobKeys.filter((k) => !seen.includes(k) && actionable.has(k)) : [];
  const ackNew = () => {
    prefs.set(seenKey, JSON.stringify(jobKeys));
    setSeen(jobKeys);
  };

  const signOut = () => {
    if (entries.length) {
      setLogoutRefused(true);
      return;
    }
    prefs.set('driver.me', null);
    s.signOut();
    nav('/driver/login', { replace: true });
  };

  if (!data) {
    return (
      <>
        <TopBar title={t('driver.title')} sub={me.name} />
        <main className="drv-main">{q.error ? <ErrorBanner error={q.error} onRetry={() => void q.refetch()} /> : <Loading />}</main>
      </>
    );
  }

  const types = typeMap(data.waste_types);
  const nightShift = data.now && data.now.slice(0, 10) !== data.today && s.meta?.day_ends_at;
  const myRouteJob = data.my_route?.job ?? null;
  const routes = data.routes;

  return (
    <>
      <TopBar
        title={day(data.today)}
        sub={me.name}
        at={q.data?.at}
        cached={q.data?.cached}
        right={
          <button type="button" className="menu-btn" onClick={() => setMenu(true)}>
            {t('driver.menu')}
          </button>
        }
        below={
          nightShift ? (
            <div className="night">
              {t('driver.nightShift', { time: fmtTime(s.meta!.day_ends_at), next: day(s.meta!.day_ends_at.slice(0, 10)) })}
            </div>
          ) : null
        }
      />
      <main className="drv-main">
        {q.error && !q.data?.cached ? <ErrorBanner error={q.error} onRetry={() => void q.refetch()} /> : null}
        {notsent.length > 0 && (
          <div className="dban error" role="alert">
            <span className="grow">{t('driver.notsent.banner', { n: notsent.length })}</span>
            <Link to="/driver/notsent">{t('driver.notsent.open')}</Link>
          </div>
        )}
        {fresh.length > 0 && (
          <div className="dban info" data-testid="new-today">
            <span className="grow">
              {t('driver.newToday', {
                list: fresh.map((k) => routes.find((r) => r.job === k)?.code ?? k).join(', '),
              })}
            </span>
            <button type="button" className="link" onClick={ackNew}>
              {t('driver.ok')}
            </button>
          </div>
        )}
        {switching && (
          <div className="dban warn">
            <span className="grow">{t('driver.switch.pick', { code: data.my_route?.code ?? '' })}</span>
            <button type="button" className="link" onClick={() => setParams({}, { replace: true })}>
              {t('common.cancel')}
            </button>
          </div>
        )}

        <MyWork data={data} />

        {/* above the routes, so the button is always one tap away */}
        {!switching && <Submissions today={data.today} types={types} free={data.waste_types.filter((w) => !w.routable)} />}

        <div className="sec" data-testid="routes-head">
          {t('driver.tab.routes', { n: routes.length })}
        </div>
        {routes.length === 0 ? (
          <div className="empty">{t('driver.noRoutes')}</div>
        ) : (
          SECTIONS.map((sec) => {
            const list = routes.filter((r) => r.status === sec);
            if (!list.length) return null;
            return (
              <section key={sec} className="stack" data-section={sec}>
                <div className={sec === 'open' ? 'sec open' : 'sec'}>{t('driver.sec.' + sec)}</div>
                {list.map((r) => (
                  <RouteCard key={r.job} card={r} myId={me.id} isNew={fresh.includes(r.job)} switching={switching && r.job !== myRouteJob} abbr={types[r.waste_type]?.abbr} />
                ))}
              </section>
            );
          })
        )}
      </main>

      <Sheet open={menu} title={t('driver.menu')} onClose={() => setMenu(false)}>
        <div className="muted">
          {me.name} · <span className="code">{me.username}</span>
        </div>
        <LangSwitch />
        <Link className="dbtn" to="/driver/notsent" onClick={() => setMenu(false)}>
          {t('driver.notsent.title')} ({notsent.length})
        </Link>
        <Link className="dbtn" to="/password" state={{ from: '/driver' }}>
          {t('menu.changePassword')}
        </Link>
        {logoutRefused && entries.length > 0 && (
          <div className="dban warn" role="alert">
            {t('driver.logoutRefused', { n: entries.length })}
          </div>
        )}
        <button type="button" className="dbtn danger" onClick={signOut}>
          {t('menu.signOut')}
        </button>
        <button type="button" className="dbtn" onClick={() => setMenu(false)}>
          {t('common.close')}
        </button>
      </Sheet>
    </>
  );
}

function MyWork({ data }: { data: DriverToday }) {
  const { t } = useI18n();
  if (!data.my_route) return null;
  const r = data.my_route;
  const routeCard = r ? data.routes.find((x) => x.job === r.job) : undefined;
  return (
    <section className="stack" data-testid="my-work">
      <div className="sec">{t('driver.myWork')}</div>
      {r && (
        <Link className="jcard mine" to={`/driver/job/${r.date}/${r.job}`} style={rcStyle(routeCard?.color) as CSSProperties}>
          <span className="bar" />
          <span className="jb">
            <span className="jl1">
              <span className="jst">{t('driver.continue')}</span>
              <span className="jcode">
                {routeCard?.type === 'adhoc' ? '⚡' : ''}
                {r.code}
              </span>
              <span className="jst">
                {r.total - r.pending}/{r.total}
              </span>
              {r.assigned && <span className="assigned">{t('driver.assigned')}</span>}
            </span>
            <span className="jmeta">
              {r.name}
              {r.vehicle_no ? ' · ' + r.vehicle_no : ''}
            </span>
          </span>
        </Link>
      )}
    </section>
  );
}

function RouteCard({ card, myId, isNew, switching, abbr }: { card: DriverRouteCard; myId: number; isNew: boolean; switching: boolean; abbr?: string }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const mine = card.status === 'active' && driverId(card.driver) === myId;
  const taken = card.status === 'active' && !mine;
  const cls = ['jcard', card.type === 'adhoc' ? 'adhoc' : '', taken ? 'taken' : '', mine ? 'mine' : ''].filter(Boolean).join(' ');
  const resolved = card.collected + card.missed;
  return (
    <button
      type="button"
      className={cls}
      style={rcStyle(card.color) as CSSProperties}
      disabled={taken}
      data-job={card.job}
      data-code={card.code}
      onClick={() => nav(`/driver/job/${card.date}/${card.job}${switching ? '?switch=1' : ''}`)}
    >
      <span className="bar" />
      <span className="jb">
        <span className="jl1">
          <span className="jcode">
            {card.type === 'adhoc' ? '⚡' : ''}
            {card.code}
          </span>
          <TypeTag type={card.type} />
          <WasteTag code={card.waste_type} abbr={abbr} />
          <span className="jname">{card.name}</span>
          {isNew && <span className="newtag">{t('driver.new')}</span>}
        </span>
        <span className="jmeta">
          {stopsText(t, card.stops)} · {card.first_customers.join(', ')}
        </span>
        {card.note && <span className="jmeta">{card.note}</span>}
        <span className={`jst ${card.status}`} data-testid="status">
          {statusText(t, card.status, { mine, driver: (driverName(card.driver) ?? '') || null, resolved, total: resolved + card.pending, leftBy: card.left_by, byOffice: !!card.released_by_office })}
        </span>
      </span>
    </button>
  );
}

/** The free submissions: the [Submit …] button and my submissions of today (unsent ones included). */
function Submissions({ today, types, free }: { today: string; types: Record<string, WasteType>; free: WasteType[] }) {
  const { t } = useI18n();
  const { entries } = useDriver();
  const q = useMySubmissions(today);
  const list = mergeSubmissions(q.data?.data.submissions ?? [], entries, today);
  if (free.length === 0 && list.length === 0) return null;
  return (
    <section className="stack" data-testid="submissions">
      <div className="sec">{t('driver.submit.section')}</div>
      {free.length > 0 && (
        <Link className="dbtn primary" to="/driver/submit" data-testid="submit-new">
          + {t('driver.submit.button', { types: free.map((w) => w.abbr || w.code).join(' / ') })}
        </Link>
      )}
      {list.map((x) => (
        <Link key={x.id} className="jcard" to={`/driver/submit/${x.date}/${x.id}`} data-submission={x.id}>
          <span className="bar" />
          <span className="jb">
            <span className="jl1">
              <WasteTag code={x.waste_type} abbr={types[x.waste_type]?.abbr} />
              <span className="jname">{x.customer}</span>
            </span>
            <span className="jmeta">
              {fmtWeight(Number(String(x.weight).replace(',', '.')))} {types[x.waste_type]?.unit ?? 'kg'}
              {x.vehicle_no ? ' · ' + x.vehicle_no : ''}
              {x.unsent ? ' · ' + t('driver.submit.unsent') : ''}
            </span>
          </span>
        </Link>
      ))}
    </section>
  );
}
