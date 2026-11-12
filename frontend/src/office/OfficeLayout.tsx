// Office layout (§9.2): brand, navigation (Users for admins only), today's op_date from /api/meta,
// the language switch and the user menu (change password, sign out, sign out everywhere).
// The calendar demo build (__WMS_DEMO__, §11.5) has no Users page and no user menu.
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useI18n, fmtTime } from '../i18n';
import { useSession } from '../session';
import { ConfirmDialog } from '../ui/Dialog';
import { useErrorText } from '../ui/Feedback';
import { LangSwitch } from '../ui/LangSwitch';

const NAV: { to: string; key: string; admin?: boolean }[] = [
  { to: '/', key: 'nav.calendar' },
  { to: '/routes', key: 'nav.routes' },
  { to: '/submissions', key: 'nav.submissions' },
  { to: '/customers', key: 'nav.customers' },
  { to: '/holidays', key: 'nav.holidays' },
  { to: '/settings', key: 'nav.settings' },
  { to: '/users', key: 'nav.users', admin: true },
];

export default function OfficeLayout() {
  const { t, day } = useI18n();
  const s = useSession();
  const meta = s.meta;

  useEffect(() => {
    document.title = t('app.name');
  }, [t]);

  // "Today · until 04:00" while the op_date is still the previous calendar date (between 00:00 and the
  // rollover, R1). The server says so: day_ends_at falls on the same calendar date as now.
  let todayText = '';
  if (meta) {
    const nightShift = meta.rollover_hour > 0 && meta.day_ends_at.slice(0, 10) === meta.now.slice(0, 10);
    todayText = nightShift
      ? t('office.todayUntil', { date: day(meta.today), time: fmtTime(meta.day_ends_at) })
      : t('office.today', { date: day(meta.today) });
  }

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">{t('app.name')}</div>
        <nav className="tabs" aria-label="Main">
          {NAV.filter((n) => !n.admin || (s.isAdmin && !__WMS_DEMO__)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {t(n.key)}
            </NavLink>
          ))}
        </nav>
        <span className="spacer" />
        {todayText && <span className="who num">{todayText}</span>}
        <LangSwitch />
        {!__WMS_DEMO__ && <UserMenu />}
      </header>
      <main className="stack">
        <Outlet />
      </main>
    </div>
  );
}

function UserMenu() {
  const { t } = useI18n();
  const s = useSession();
  const nav = useNavigate();
  const errText = useErrorText();
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!s.me) return null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {s.me.name} <span className="muted small">· {t(`role.${s.me.role}`)}</span> ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">
            <span className="code">{s.me.username}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); nav('/password'); }}>
            {t('menu.changePassword')}
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); s.signOut(); }}>
            {t('menu.signOut')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setConfirmAll(true); }}>
            {t('menu.signOutAll')}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmAll}
        title={t('menu.signOutAll')}
        confirmLabel={t('menu.signOutAll')}
        danger
        busy={busy}
        error={error}
        onClose={() => setConfirmAll(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await s.signOutEverywhere();
          } catch (e) {
            setError(errText(e));
            setBusy(false);
          }
        }}
      >
        <p style={{ margin: 0 }}>{t('menu.signOutAllConfirm')}</p>
      </ConfirmDialog>
    </div>
  );
}
