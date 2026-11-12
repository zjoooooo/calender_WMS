// The driver app at /driver/* (§9.3), a lazy chunk (§11.1). It never imports @dnd-kit.
//   /driver/login                         S0 Login
//   /driver                               S1 Today (?switch=1: pick the route to switch to)
//   /driver/job/:date/:job                S2 preview or S3 Run
//   /driver/submit                        a free submission: waste type -> customer -> form
//   /driver/submit/:date/:id              change or delete a submission (?notsent=<id>: a refused one)
//   /driver/job/:date/:job/stop/:cid      S4 Result form of a route stop (?notsent=<id>: edit a refused entry)
//   /driver/job/:date/:job/done           S6 Route done
//   /driver/notsent                       S7 Not sent
// Theme: high-contrast light (data-app="driver"). Offline start: the signed-in driver is remembered on the
// phone, so the app opens with zero signal and shows the cached lists (§7.7); a 401 later still signs out.
import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getToken, prefs, type User } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { ErrorBanner, Loading } from '../ui/Feedback';
import Done from './Done';
import { DriverProvider, type DriverMe } from './driverContext';
import JobPage, { StopPage } from './JobPage';
import Login from './Login';
import NotSent from './NotSent';
import SubmitPage, { SubmissionPage } from './SubmitPage';
import Today from './Today';
import './driver.css';

const ME_PREF = 'driver.me';

/** The driver remembered for this token (never another driver's record with a new token). */
function cachedMe(): User | null {
  try {
    const raw = prefs.get(ME_PREF);
    const v = raw ? (JSON.parse(raw) as { token: string; me: User }) : null;
    return v && v.token === getToken() ? v.me : null;
  } catch {
    return null;
  }
}

export default function DriverApp() {
  useEffect(() => {
    document.documentElement.dataset.app = 'driver';
    return () => {
      delete document.documentElement.dataset.app;
    };
  }, []);
  return (
    <div className="drv">
      <Routes>
        <Route path="login" element={<Login />} />
        <Route path="*" element={<Authed />} />
      </Routes>
    </div>
  );
}

function Authed() {
  const s = useSession();
  const { t } = useI18n();
  const loc = useLocation();

  // Remember the driver for an offline start; forget on sign-out.
  useEffect(() => {
    if (s.me && s.token && s.me.role === 'driver' && !s.me.must_change_password) prefs.set(ME_PREF, JSON.stringify({ token: s.token, me: s.me }));
  }, [s.me, s.token]);

  if (!s.token) return <Navigate to="/driver/login" replace state={{ from: loc.pathname }} />;
  const remembered = cachedMe();
  const me = s.me ?? remembered ?? undefined;
  if (!me) {
    return (
      <main className="drv-main">
        {s.meError ? <ErrorBanner error={s.meError} onRetry={() => location.reload()} /> : <Loading />}
      </main>
    );
  }
  if (me.must_change_password) return <Navigate to="/password" replace state={{ from: '/driver' }} />;
  if (me.role !== 'driver') {
    return (
      <main className="drv-main">
        <div className="dban warn">{t('driver.onlyDrivers')}</div>
        <Link className="dbtn primary" to="/">
          {t('driver.officeLink')}
        </Link>
      </main>
    );
  }
  const dm: DriverMe = { id: me.id, username: me.username, name: me.name };
  return (
    <DriverProvider me={dm}>
      <Routes>
        <Route index element={<Today />} />
        <Route path="notsent" element={<NotSent />} />
        <Route path="submit" element={<SubmitPage />} />
        <Route path="submit/:date/:id" element={<SubmissionPage />} />
        <Route path="job/:date/:job" element={<JobPage />} />
        <Route path="job/:date/:job/stop/:cid" element={<StopPage />} />
        <Route path="job/:date/:job/done" element={<Done />} />
        <Route path="*" element={<Navigate to="/driver" replace />} />
      </Routes>
    </DriverProvider>
  );
}
