// Session: the token, the signed-in user (/api/me), /api/meta, the per-user language and the rollover
// refetch (R36). Every page reads it through useSession().
//
// Rollover: when any response carries a `today` different from meta.today, or when the timer set from
// meta.day_ends_at fires, EVERY query is invalidated (calendar ranges, lists, drawers, the driver's jobs)
// and /api/meta is fetched again, which re-arms the timer from the new day_ends_at.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { Lang, LoginResult, Meta, User } from './api';
import { useI18n } from './i18n';
import { armRolloverTimer, watchRollover } from './rollover';

export interface Session {
  token: string | null;
  me: User | undefined;
  meError: unknown;
  /** /api/meta (undefined until loaded, and while a password change is required). */
  meta: Meta | undefined;
  isAdmin: boolean;
  isOffice: boolean; // admin or office
  signIn: (r: LoginResult) => void;
  /** After a password change: the old token no longer works. */
  replaceToken: (token: string) => void;
  signOut: () => void;
  signOutEverywhere: () => Promise<void>;
  /** Switches the UI language and saves it on the user (PATCH /api/me). */
  changeLang: (lang: Lang) => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export const ME_KEY = ['me'] as const;
export const META_KEY = ['meta'] as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { setLang } = useI18n();
  const [token, setTokenState] = useState<string | null>(() => api.getToken());

  const meQ = useQuery({
    queryKey: ME_KEY,
    queryFn: api.getMe,
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: (n, e) => !(e instanceof api.ApiError && e.http > 0 && e.http < 500) && n < 2,
  });
  const me = token ? meQ.data : undefined;
  const metaQ = useQuery({
    queryKey: META_KEY,
    queryFn: api.getMeta,
    enabled: !!token && !!me && !me.must_change_password,
    staleTime: 60_000,
    // Keeps meta.now fresh enough for the "Today · until 04:00" label after midnight (display only;
    // the rollover itself is handled by the timer below).
    refetchInterval: 5 * 60_000,
  });
  const meta = me && !me.must_change_password ? metaQ.data : undefined;

  // The user's stored language wins once known.
  useEffect(() => {
    if (me?.lang) setLang(me.lang);
  }, [me?.lang, setLang]);

  const signOut = useCallback(() => {
    api.setToken(null);
    setTokenState(null);
    qc.clear();
  }, [qc]);

  // Global API events. knownToday moves to the new day at the first response that shows it, so one
  // rollover invalidates everything exactly once, even while several refetches are in flight.
  const knownToday = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (meta?.today) knownToday.current = meta.today;
  }, [meta?.today]);
  useEffect(() => {
    const offs = [
      api.onUnauthorized(() => signOut()),
      api.onPasswordChangeRequired(() => void qc.invalidateQueries({ queryKey: ME_KEY })),
      watchRollover(qc, knownToday),
    ];
    return () => offs.forEach((off) => off());
  }, [qc, signOut]);

  // Timer to the rollover, from the server's own day_ends_at - now.
  useEffect(() => {
    if (!meta) return;
    return armRolloverTimer(qc, meta, metaQ.dataUpdatedAt || Date.now());
  }, [meta, metaQ.dataUpdatedAt, qc]);

  const signIn = useCallback(
    (r: LoginResult) => {
      qc.clear();
      api.setToken(r.token);
      setTokenState(r.token);
      qc.setQueryData(ME_KEY, r.user);
      setLang(r.user.lang);
    },
    [qc, setLang],
  );

  const replaceToken = useCallback(
    (t: string) => {
      api.setToken(t);
      setTokenState(t);
      // The change is done: drop the flag now, so the guards do not bounce back to /password while
      // /api/me is refetched.
      qc.setQueryData<User>(ME_KEY, (u) => (u ? { ...u, must_change_password: false } : u));
      void qc.invalidateQueries();
    },
    [qc],
  );

  const signOutEverywhere = useCallback(async () => {
    await api.logoutAll();
    signOut();
  }, [signOut]);

  const changeLang = useCallback(
    async (lang: Lang) => {
      setLang(lang);
      // Signed out, or a password change is pending (the server refuses PATCH /api/me until then):
      // the choice stays in this browser only.
      const cur = qc.getQueryData<User>(ME_KEY);
      if (!api.getToken() || !cur || cur.must_change_password) return;
      const u = await api.patchMe({ lang });
      qc.setQueryData(ME_KEY, u);
      void qc.invalidateQueries({ queryKey: META_KEY });
    },
    [qc, setLang],
  );

  const value = useMemo<Session>(
    () => ({
      token,
      me,
      meError: meQ.error,
      meta,
      isAdmin: me?.role === 'admin',
      isOffice: me?.role === 'admin' || me?.role === 'office',
      signIn,
      replaceToken,
      signOut,
      signOutEverywhere,
      changeLang,
    }),
    [token, me, meQ.error, meta, signIn, replaceToken, signOut, signOutEverywhere, changeLang],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Home path for a role: drivers go to /driver (§11.3). */
export function homeFor(user: Pick<User, 'role'> | undefined): string {
  return user?.role === 'driver' ? '/driver' : '/';
}
