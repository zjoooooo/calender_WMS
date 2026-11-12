// S0 Login (§9.3): the shared auth (POST /api/login, session.signIn) with driver ergonomics: the
// username is remembered, a large password field, a language toggle and inline errors; a locked
// account reads "Try again at 07:52". After login the app asks the browser to keep its storage
// (navigator.storage.persist), so the outbox is not evicted (§7.7).
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { login, prefs } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { useErrorText } from '../ui/Feedback';
import { LangSwitch } from '../ui/LangSwitch';

export function persistStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* not supported */
  }
}

export default function Login() {
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
    document.title = `${t('driver.login.title')} · WMS`;
  }, [t]);

  if (s.token && s.me) {
    if (s.me.must_change_password) return <Navigate to="/password" replace state={{ from: '/driver' }} />;
    return <Navigate to={s.me.role === 'driver' ? '/driver' : '/'} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(username.trim(), password);
      prefs.set('username', username.trim());
      s.signIn(r);
      persistStorage();
      if (r.user.must_change_password) nav('/password', { replace: true, state: { from: '/driver' } });
      else if (r.user.role !== 'driver') nav('/', { replace: true });
      else nav(from && from.startsWith('/driver') && !from.startsWith('/driver/login') ? from : '/driver', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="dlogin" onSubmit={submit} noValidate>
      <div className="row">
        <div className="brand">{t('driver.title')}</div>
        <span className="spacer" />
        <LangSwitch />
      </div>
      <h1>{t('driver.login.title')}</h1>
      <label className="dfield">
        <span>{t('login.username')}</span>
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus={!username}
        />
      </label>
      <label className="dfield">
        <span>{t('login.password')}</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus={!!username}
        />
      </label>
      {error != null && (
        <div className="form-err" role="alert">
          {errText(error)}
        </div>
      )}
      <button type="submit" className="dbtn primary big" disabled={busy || !username.trim() || !password}>
        {busy ? t('login.working') : t('login.submit')}
      </button>
    </form>
  );
}
