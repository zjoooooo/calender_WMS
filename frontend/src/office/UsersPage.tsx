// Users page (admin, §9.2, R33, R34): username, name, role, language, active, login lock and, for
// drivers, the jobs they hold today (GET /api/drivers, R25). Actions: new user, edit, reset password
// (must change at next login; clears login locks), deactivate (releases the driver's jobs) / activate.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createUser, listDrivers, listUsers, patchUser, type Lang, type Role, type UserRow } from '../api';
import { fmtTime, useI18n } from '../i18n';
import { useSession } from '../session';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { randomPassword } from '../ui/uuid';

const ROLES: Role[] = ['admin', 'office', 'driver'];

export default function UsersPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const usersQ = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const driversQ = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const drivers = new Map((driversQ.data ?? []).map((d) => [d.id, d]));
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['drivers'] });
  };

  const setActive = async (u: UserRow, active: boolean) => {
    setBusy(true);
    setToggleError(null);
    try {
      await patchUser(u.id, { active });
      toast(t('users.saved'));
      setToggling(null);
      refresh();
    } catch (e) {
      setToggleError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = usersQ.data ?? [];
  return (
    <>
      <div className="page-head">
        <h1>{t('users.title')}</h1>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          + {t('users.new')}
        </button>
      </div>
      <ErrorBanner error={usersQ.error} onRetry={() => usersQ.refetch()} />
      {usersQ.isLoading && <Loading />}
      {usersQ.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('users.colUsername')}</th>
                <th>{t('users.colName')}</th>
                <th>{t('users.colRole')}</th>
                <th>{t('users.colLang')}</th>
                <th>{t('users.colStatus')}</th>
                <th>{t('users.colLocked')}</th>
                <th>{t('users.colJobs')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const d = drivers.get(u.id);
                return (
                  <tr key={u.id} className={u.active ? undefined : 'dim'}>
                    <td className="code">
                      {u.username}
                      {me?.id === u.id && <span className="muted small"> {t('users.you')}</span>}
                    </td>
                    <td>{u.name}</td>
                    <td>{t(`role.${u.role}`)}</td>
                    <td>{t(`lang.${u.lang}`)}</td>
                    <td className="nowrap">
                      {u.active ? <span className="tag ok">{t('common.active')}</span> : <span className="tag">{t('common.inactive')}</span>}{' '}
                      {u.must_change_password && <span className="tag warn">{t('users.mustChange')}</span>}
                    </td>
                    <td className="small nowrap">{u.locked_until ? <span className="tag danger">🔒 {t('users.lockedUntil', { time: fmtTime(u.locked_until) })}</span> : '–'}</td>
                    <td className="small">
                      {u.role === 'driver' && d ? (
                        <>
                          {d.route_job && <div>{t('users.routeJob', { code: d.route_job.code, pending: d.route_job.pending })}</div>}
                          {d.task_jobs.length > 0 && <div title={d.task_jobs.map((j) => j.customer).join(', ')}>{t('users.taskJobs', { n: d.task_jobs.length })}</div>}
                          {!d.route_job && d.task_jobs.length === 0 && '–'}
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="actions">
                      <button type="button" className="btn small" onClick={() => setEditing(u)}>
                        {t('common.edit')}
                      </button>
                      <button type="button" className="btn small" onClick={() => setResetting(u)}>
                        {t('users.resetPassword')}
                      </button>
                      {u.active ? (
                        <button type="button" className="btn small danger" onClick={() => { setToggleError(null); setToggling(u); }}>
                          {t('users.deactivate')}
                        </button>
                      ) : (
                        <button type="button" className="btn small" disabled={busy} onClick={() => setActive(u, true)}>
                          {t('users.activate')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {toggleError && !toggling && <div className="form-error">{toggleError}</div>}

      {editing && <UserDialog user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onSaved={refresh} />}
      <ConfirmDialog
        open={!!toggling}
        title={toggling ? t('users.deactivateTitle', { name: toggling.name }) : ''}
        confirmLabel={t('users.deactivate')}
        danger
        busy={busy}
        error={toggleError}
        onClose={() => setToggling(null)}
        onConfirm={() => toggling && setActive(toggling, false)}
      >
        <p style={{ margin: 0 }}>{t('users.deactivateText')}</p>
      </ConfirmDialog>
    </>
  );
}

function UserDialog({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const isNew = user === null;
  const [username, setUsername] = useState(user?.username ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'driver');
  const [lang, setLang] = useState<Lang>(user?.lang ?? 'zh');
  const [password, setPassword] = useState(() => (isNew ? randomPassword() : ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isNew && password.length < 8) return setError(t('err.PASSWORD_TOO_SHORT'));
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const u = await createUser({ username: username.trim().toLowerCase(), name: name.trim(), role, lang, password });
        toast(t('users.created', { username: u.username }), 'info', 6000);
      } else {
        await patchUser(user.id, { name: name.trim(), role, lang });
        toast(t('users.saved'));
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={isNew ? t('users.new') : t('users.edit', { username: user.username })}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="user-form" className="btn primary" disabled={busy || !name.trim() || (isNew && !username.trim())}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={submit} noValidate>
        <label className="field">
          <span>{t('users.username')}</span>
          <input
            className="code"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            disabled={!isNew}
            maxLength={30}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>{t('users.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label className="field">
          <span>{t('users.role')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('users.lang')}</span>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="zh">{t('lang.zh')}</option>
            <option value="en">{t('lang.en')}</option>
          </select>
        </label>
        {isNew && (
          <div className="field full">
            <span>{t('users.password')}</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input code" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" spellCheck={false} />
              <button type="button" className="btn" onClick={() => setPassword(randomPassword())}>
                {t('users.generate')}
              </button>
            </div>
            <span className="hint">{t('users.passwordHint')}</span>
          </div>
        )}
        {error && (
          <div className="full form-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const [password, setPassword] = useState(() => randomPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError(t('err.PASSWORD_TOO_SHORT'));
    setBusy(true);
    setError(null);
    try {
      await patchUser(user.id, { password });
      toast(t('users.resetDone', { name: user.name }));
      onSaved();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('users.resetTitle', { name: user.name })}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="reset-form" className="btn primary" disabled={busy}>
            {t('users.resetPassword')}
          </button>
        </>
      }
    >
      <form id="reset-form" className="stack" onSubmit={submit} noValidate>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input code" value={password} onChange={(e) => setPassword(e.target.value)} aria-label={t('pw.new')} autoComplete="new-password" spellCheck={false} />
          <button type="button" className="btn" onClick={() => setPassword(randomPassword())}>
            {t('users.generate')}
          </button>
        </div>
        <div className="muted small">{t('users.resetHint')}</div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}
