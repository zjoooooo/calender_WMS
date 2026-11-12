// Driver app context: the signed-in driver, the online flag and the outbox runner (§7.7).
// The runner flushes after every save, on the `online` event, on focus / when the page becomes visible,
// and every 15 s (backing off to 60 s while sending fails). Results of a flush refresh the driver queries.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api';
import { useI18n } from '../i18n';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { draftFileNames } from './cache';
import { outboxApi } from './submission';
import { createIdbOutbox, nextFlushDelay, type FlushResult, type NotSentEntry, type Outbox, type OutboxEntry, type OutboxEvent, type SaveInput } from './outbox';

export interface DriverMe {
  id: number;
  username: string;
  name: string;
}

export interface DriverCtx {
  me: DriverMe;
  online: boolean;
  box: Outbox;
  /** Waiting outbox entries of this driver (oldest first). */
  entries: OutboxEntry[];
  /** `entries` and `notsent` have been read from the device at least once (they start empty). */
  ready: boolean;
  notsent: NotSentEntry[];
  /** The last flush stopped on a network error / timeout / 5xx. */
  failing: boolean;
  /** Local time (ms) of the last entry the server acknowledged. */
  lastSentAt: number | null;
  save: (input: SaveInput) => Promise<OutboxEntry>;
  /** Sends now (and waits). */
  flushNow: () => Promise<FlushResult>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<DriverCtx | null>(null);

export function useDriver(): DriverCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDriver outside DriverProvider');
  return v;
}

export function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

export function DriverProvider({ me, children }: { me: DriverMe; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const errText = useErrorText();
  const online = useOnline();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [notsent, setNotsent] = useState<NotSentEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [failing, setFailing] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);

  // Event texts use the latest t/toast without rebuilding the outbox.
  const onEventRef = useRef<(e: OutboxEvent) => void>(() => {});
  onEventRef.current = (e: OutboxEvent) => {
    if (e.type === 'conflict') toast(t('driver.toast.conflict', { customer: e.entry.label.customer }), 'warn', 5000);
    if (e.type === 'refused') {
      const err = new ApiError(e.entry.error.code, e.entry.error.http, e.entry.error.message, e.entry.error.field, e.entry.error.details);
      toast(t('driver.toast.refused', { customer: e.entry.label.customer, error: errText(err) }), 'error', 6000);
    }
  };

  const box = useMemo(
    () =>
      createIdbOutbox(
        me.id,
        outboxApi(),
        {
          extraRefs: draftFileNames,
          isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
          onEvent: (e) => onEventRef.current(e),
        },
      ),
    [me.id],
  );

  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([box.list(), box.listNotSent()]);
      setEntries(a);
      setNotsent(b);
    } finally {
      setReady(true);
    }
  }, [box]);

  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);

  const flushNow = useCallback(async (): Promise<FlushResult> => {
    if (timer.current) clearTimeout(timer.current);
    const r = await box.flush();
    failures.current = r.stopped === 'network' ? failures.current + 1 : 0;
    if (alive.current) {
      setFailing(r.stopped === 'network');
      if (r.sent) setLastSentAt(Date.now());
      await refresh();
      if (r.sent || r.conflicts || r.refused) void qc.invalidateQueries({ queryKey: ['driver'] });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flushNow(), nextFlushDelay(failures.current));
    }
    return r;
  }, [box, qc, refresh]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    void flushNow();
    const kick = () => void flushNow();
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick();
    };
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flushNow, refresh]);

  const save = useCallback(
    async (input: SaveInput) => {
      const e = await box.save(input);
      await refresh();
      setTimeout(() => void flushNow(), 0); // "a flush starts after every save"
      return e;
    },
    [box, refresh, flushNow],
  );

  const value = useMemo<DriverCtx>(
    () => ({ me, online, box, entries, ready, notsent, failing, lastSentAt, save, flushNow, refresh }),
    [me, online, box, entries, ready, notsent, failing, lastSentAt, save, flushNow, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
