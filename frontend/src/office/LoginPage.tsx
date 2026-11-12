// Login (§9.2): username, password and a language toggle. A first login with must_change_password goes
// to "Set new password"; a driver goes to /driver, an office user to the page they came from.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { login, prefs } from '../api';
import { useI18n } from '../i18n';
import { homeFor, useSession } from '../session';
import { useErrorText } from '../ui/Feedback';
import { LangSwitch } from '../ui/LangSwitch';

export default function LoginPage() {
  const { t } = useI18n();
  const s = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  const errText = useErrorText();
  const [username, setUsername] = useState(() => prefs.get('username') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('login.title')} · WMS`;
  }, [t]);

  if (s.token && s.me) {
    if (s.me.must_change_password) return <Navigate to="/password" replace state={{ from }} />;
    return <Navigate to={pickTarget(from, s.me.role)} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(username.trim(), password);
      prefs.set('username', username.trim());
      s.signIn(r);
      if (r.user.must_change_password) nav('/password', { replace: true, state: { from } });
      else nav(pickTarget(from, r.user.role), { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <div className="brand">{t('app.name')}</div>
        <div className="row">
          <h1>{t('login.title')}</h1>
          <span className="spacer" />
          <LangSwitch />
        </div>
        <label className="field">
          <span>{t('login.username')}</span>
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus={!username}
          />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={!!username}
          />
        </label>
        {error != null && (
          <div className="form-error" role="alert">
            {errText(error)}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || !username.trim() || !password} style={{ justifyContent: 'center' }}>
          {busy ? t('login.working') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}

/** Where to go after login: the page the user came from when it fits the role, else the role's home. */
function pickTarget(from: string | undefined, role: string): string {
  const home = homeFor({ role: role as 'admin' });
  if (!from || from.startsWith('/login') || from.startsWith('/password')) return home;
  if (role === 'driver') return from.startsWith('/driver') ? from : home;
  return from;
}
