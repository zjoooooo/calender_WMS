// Set new password (§9.2, R33): forced after the first login or an admin reset (no way around it:
// every other call returns PASSWORD_CHANGE_REQUIRED), or chosen from the user menu.
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { changePassword } from '../api';
import { useI18n } from '../i18n';
import { homeFor, useSession } from '../session';
import { Loading, useErrorText } from '../ui/Feedback';
import { LangSwitch } from '../ui/LangSwitch';
import { useToast } from '../ui/Toast';

export default function ChangePasswordPage() {
  const { t } = useI18n();
  const s = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const errText = useErrorText();
  const from = (loc.state as { from?: string } | null)?.from;
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!s.token) return <Navigate to="/login" replace />;
  if (!s.me) return <div className="center-screen"><Loading /></div>;
  const forced = s.me.must_change_password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPw.length < 8) return setError(t('pw.tooShort'));
    if (newPw !== again) return setError(t('pw.mismatch'));
    setBusy(true);
    setError(null);
    try {
      const r = await changePassword(oldPw, newPw);
      s.replaceToken(r.token);
      toast(t('pw.changed'));
      const target = from && !from.startsWith('/password') && !from.startsWith('/login') ? from : homeFor(s.me);
      nav(s.me?.role === 'driver' && !target.startsWith('/driver') ? '/driver' : target, { replace: true });
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <div className="brand">{t('app.name')}</div>
        <div className="row">
          <h1>{t('pw.title')}</h1>
          <span className="spacer" />
          <LangSwitch />
        </div>
        {forced && <div className="banner warn">{t('pw.forced')}</div>}
        <div className="muted small">
          {s.me.name} · <span className="code">{s.me.username}</span>
        </div>
        <label className="field">
          <span>{t('pw.old')}</span>
          <input name="old" type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>{t('pw.new')}</span>
          <input name="new" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('pw.confirm')}</span>
          <input name="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          {!forced && (
            <button type="button" className="btn" onClick={() => nav(-1)}>
              {t('common.cancel')}
            </button>
          )}
          {forced && (
            <button type="button" className="btn ghost" onClick={s.signOut}>
              {t('menu.signOut')}
            </button>
          )}
          <span className="spacer" />
          <button type="submit" className="btn primary" disabled={busy || !oldPw || !newPw || !again}>
            {t('pw.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
