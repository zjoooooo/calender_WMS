// Shared pieces of the office calendar, routes and tasks pages: the guarded write (busy / error /
// RUN_EXISTS retry with release_run / STALE_REVISION refetch), query invalidation after plan writes, a
// small popover menu, and text helpers for rules, totals and run status (§6.1, §8.3, §6.11).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, isApiError, type Lang, type RouteOccurrence, type RunSummary, type WasteType, type OpsCounts } from '../api';
import { fmtDay, fmtTime, fmtWeight, weekdayList } from '../i18n';
import { useErrorText } from '../ui/Feedback';
import { RunExistsDialog } from './RunExistsDialog';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Every query a plan or run write can change. */
export function useInvalidatePlan(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const key of ['calendar', 'routes', 'route', 'tasks', 'task', 'customers', 'customer', 'drivers', 'run']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [qc]);
}

export interface GuardedWrite {
  busy: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  /**
   * Runs a write. `fn(releaseRun)` is called with false first; on 409 RUN_EXISTS the R26 dialog opens and
   * [Release the driver and continue] calls it again with true. Resolves to the result, or undefined when
   * the write failed or is waiting for that dialog. Every outcome refetches the plan queries, so a
   * STALE_REVISION shows the latest version while the caller keeps its draft (R20).
   */
  run: <R>(fn: (releaseRun: boolean) => Promise<R>, onDone?: (r: R) => void) => Promise<R | undefined>;
  /** The RUN_EXISTS dialog element; render it once. */
  dialog: ReactNode;
}

export function useGuardedWrite(): GuardedWrite {
  const invalidate = useInvalidatePlan();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const exec = useCallback(
    async <R,>(fn: (releaseRun: boolean) => Promise<R>, onDone: ((r: R) => void) | undefined, release: boolean): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn(release);
        invalidate();
        if (mounted.current) setBlocked(null);
        onDone?.(r);
        return r;
      } catch (e) {
        invalidate();
        if (!mounted.current) return undefined;
        if (isApiError(e, 'RUN_EXISTS') && !release) {
          setBlocked({ error: e, retry: () => void exec(fn, onDone, true) });
        } else {
          setBlocked(null);
          setError(errText(e));
        }
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [invalidate, errText],
  );

  const run = useCallback(<R,>(fn: (releaseRun: boolean) => Promise<R>, onDone?: (r: R) => void) => exec(fn, onDone, false), [exec]);

  const dialog = (
    <RunExistsDialog
      error={blocked?.error ?? null}
      busy={busy}
      onClose={() => setBlocked(null)}
      onRelease={() => {
        const b = blocked;
        setBlocked(null);
        b?.retry();
      }}
    />
  );
  return { busy, error, setError, run, dialog };
}

// ---- popover menu ----------------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}

/** A button with a small popover menu (closes on outside click and Esc). `null` items draw a separator. */
export function MenuButton({ label, items, className, align = 'right', up }: { label: ReactNode; items: (MenuItem | null)[]; className?: string; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const style = { [align]: 0, ...(up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : {}) };
  return (
    <div ref={ref} className="menu-wrap">
      <button type="button" className={className ?? 'btn'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div className="menu" role="menu" style={{ ...style, right: align === 'right' ? 0 : 'auto' }}>
          {items.map((it, i) =>
            it === null ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={it.title}
                className={it.danger ? 'danger' : undefined}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---- text helpers ----------------------------------------------------------------------------------

export interface RuleSource {
  type: RouteOccurrence['type'];
  recurring: boolean;
  days?: number[] | null;
  sun?: boolean | null;
  ph?: boolean | null;
  date?: string | null;
  start?: string | null;
  end?: string | null;
}

/** "Regular · Mon Wed Fri" / "Special · every Sunday + every PH" / "Adhoc · only Thu 12 Nov" (§6.1). */
export function routeRuleText(r: RuleSource, t: T, lang: Lang, withPeriod = false): string {
  const type = t(`type.${r.type}`);
  let rule: string;
  if (!r.recurring) {
    rule = t('rule.only', { date: fmtDay(r.date ?? '', lang) });
  } else if (r.type === 'regular') {
    rule = weekdayList(r.days ?? [], lang);
  } else {
    rule = [r.sun ? t('rule.everySun') : '', r.ph ? t('rule.everyPh') : ''].filter(Boolean).join(' + ');
  }
  let text = `${type} · ${rule}`;
  if (withPeriod && r.recurring && r.start) {
    text += ' · ' + t('rule.from', { date: fmtDay(r.start, lang, { weekday: false }) });
    if (r.end) text += ' ' + t('rule.until', { date: fmtDay(r.end, lang, { weekday: false }) });
  }
  return text;
}

/** "REL 2,410 kg · OTC 300 kg" in waste-type order. */
export function totalsText(totals: Record<string, number> | undefined, types: WasteType[] | undefined): string {
  if (!totals) return '';
  const order = (types ?? []).map((w) => w.code);
  const codes = Object.keys(totals).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return codes
    .filter((c) => totals[c] > 0)
    .map((c) => {
      const w = types?.find((x) => x.code === c);
      return `${w?.abbr || c} ${fmtWeight(totals[c])} ${w?.unit ?? 'kg'}`;
    })
    .join(' · ');
}

/** Today's ops line "○3 ◑6 ⇄1 ✓2" (§8.3); past days add "!n" and "–n". */
export function opsText(ops: OpsCounts | undefined, past: boolean): string {
  if (!ops) return '';
  const parts: string[] = [];
  if (!past) {
    if (ops.not_started) parts.push(`○${ops.not_started}`);
    if (ops.active) parts.push(`◑${ops.active}`);
    if (ops.open) parts.push(`⇄${ops.open}`);
  }
  if (ops.done) parts.push(`✓${ops.done}`);
  if (ops.incomplete) parts.push(`!${ops.incomplete}`);
  if (ops.no_record) parts.push(`–${ops.no_record}`);
  return parts.join(' ');
}

/**
 * The detail line of a run status (tooltip and drawer, §8.3), e.g.
 * "Ali · 3/8 · GBA1234X · REL 420.5 kg · last activity 10:12".
 */
export function runDetailText(
  status: string | null,
  run: RunSummary | null,
  t: T,
  types: WasteType[] | undefined,
  nowIso?: string,
): string {
  if (!status) return '';
  const totals = run ? totalsText(run.totals as Record<string, number>, types) : '';
  const resolved = run ? run.collected + run.missed : 0;
  switch (status) {
    case 'active': {
      const parts = [run?.driver?.name ?? '', run ? `${resolved}/${run.total}` : '', run?.vehicle_no ?? '', totals];
      if (run?.last_activity_at) {
        parts.push(t('run.lastActivity', { time: fmtTime(run.last_activity_at) }));
        if (nowIso) {
          const quiet = Math.floor((Date.parse(nowIso) - Date.parse(run.last_activity_at)) / 60000);
          if (quiet >= 15) parts.push(t('run.quiet', { n: quiet }));
        }
      }
      return parts.filter(Boolean).join(' · ');
    }
    case 'open':
      return [t('status.open'), run?.left_by ? t('run.leftBy', { name: run.left_by }) : '', run ? `${resolved}/${run.total}` : ''].filter(Boolean).join(' · ');
    case 'done': {
      const parts = [t('status.done')];
      if (run?.missed) parts.push(t('run.missedN', { n: run.missed }));
      if (totals) parts.push(totals);
      if (run?.holders.length) parts.push(run.holders.join(' → '));
      return parts.join(' · ');
    }
    case 'incomplete':
      return [t('status.incomplete'), run ? `${resolved}/${run.total}` : '', totals].filter(Boolean).join(' · ');
    case 'not_started':
      return t('run.notStarted');
    default:
      return t(`status.${status}`);
  }
}

/** True while today's job has resolved stops: skip / delete / end are refused (§6.11). */
export function workDone(run: RunSummary | null | undefined): boolean {
  return !!run && run.collected + run.missed > 0;
}

/** A day label used by forms: "Wed 18 Nov". */
export function dayLabel(date: string, lang: Lang): string {
  return date ? fmtDay(date, lang) : '';
}
