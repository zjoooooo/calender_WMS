// Office calendar (§9.2, M3–M7 office side): top bar (big month title · ‹ Today › · Week | Month · ⚡ Urgent
// pickup · + Task), filter bar (search, R / S / ⚡A chips, one chip per task type, Clear highlight, Expand /
// Collapse all), legend, month (default) or week view, Sunday first, and every drawer and dialog, opened
// through one `open()` (calendarContext).
// - view and anchor live in the URL (?view=week&anchor=2026-12-25), so Holidays-page links work; no view = month.
// - One query per view and anchor (week_start=sun); it polls every 30 s while the range contains today and on
//   focus (R36). Expanded month cells are kept per date here, so a refetch never collapses them.
// - Highlight and search are exclusive (the last used wins); Esc clears them when no layer is open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { getCalendar, type CalendarView, type RouteOccurrence, type RouteType, type TaskOccurrence } from '../api';
import { fmtDay, monthName, useI18n } from '../i18n';
import { useSession } from '../session';
import { Drawer } from '../ui/Drawer';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { anyLayerOpen } from '../ui/layer';
import { rcStyle } from '../ui/palette';
import { CalendarContext, type CalendarCtx, type Overlay } from './calendarContext';
import { groupDays, legendItems, makeMatcher, monthCellLines, monthWeeks, rangeContainsToday, shortName, type Filters } from './calendarModel';
import { DayColumn, MonthView, WeekView } from './CalendarViews';
import { CopyDialog } from './CopyDialog';
import { RouteDrawer } from './RouteDrawer';
import { RouteForm } from './RouteForm';
import { TaskDialog } from './TaskDialog';
import { TaskDrawer } from './TaskDrawer';
import { UrgentDialog } from './UrgentDialog';
import './office.css';

type DrawerOverlay = Extract<Overlay, { kind: 'route' | 'task' }>;
type DialogOverlay = Exclude<Overlay, { kind: 'route' | 'task' | 'day' }>;

export default function CalendarPage() {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const [params, setParams] = useSearchParams();
  const view: CalendarView = params.get('view') === 'week' ? 'week' : 'month';
  const anchor = params.get('anchor') ?? '';

  const q = useQuery({
    queryKey: ['calendar', view, anchor, 'sun'],
    queryFn: ({ signal }) => getCalendar(view, anchor, { signal }, 'sun'),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (rangeContainsToday(query.state.data) ? 30_000 : false),
    refetchOnWindowFocus: true,
  });
  const data = q.data;

  const [hl, setHl] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState<Record<RouteType, boolean>>({ regular: true, special: true, adhoc: true });
  const [hiddenTaskTypes, setHiddenTaskTypes] = useState<string[]>([]);
  const filters: Filters = useMemo(() => ({ types, hiddenTaskTypes }), [types, hiddenTaskTypes]);

  const [drawer, setDrawer] = useState<DrawerOverlay | null>(null);
  const [dayDrawer, setDayDrawer] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogOverlay | null>(null);
  /** Month cells the office expanded, per date (survives refetches and navigation). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleCell = useCallback((date: string, on: boolean) => setExpanded((s) => ({ ...s, [date]: on })), []);

  const setNav = (v: CalendarView, a: string) => {
    const p = new URLSearchParams();
    if (v === 'week') p.set('view', 'week');
    if (a) p.set('anchor', a);
    setParams(p, { replace: true });
  };

  const toggleHighlight = useCallback((code: string) => {
    setHl((cur) => (cur === code ? null : code));
    setSearch('');
  }, []);

  // Esc clears the highlight / search when no drawer or dialog is open.
  const escRef = useRef(() => {});
  escRef.current = () => {
    if (!anyLayerOpen() && (hl || search)) {
      setHl(null);
      setSearch('');
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && escRef.current();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const matcher = useMemo(() => makeMatcher(data, hl, search), [data, hl, search]);
  const groups = useMemo(() => (data ? groupDays(data, filters) : []), [data, filters]);
  const legend = useMemo(() => legendItems(data, filters), [data, filters]);
  // Month cells with more than 4 lines (after the filters): what Expand all / Collapse all acts on.
  const collapsible = useMemo(
    () => (view === 'month' ? monthWeeks(groups).flat().filter((g) => monthCellLines(g, false).collapsible).map((g) => g.day.date) : []),
    [view, groups],
  );
  const allOpen = collapsible.length > 0 && collapsible.every((d) => expanded[d]);
  const taskTypes = (meta?.waste_types ?? []).filter((w) => !w.routable && w.active);

  const open = useCallback((o: Overlay) => {
    if (o.kind === 'route' || o.kind === 'task') setDrawer(o);
    else if (o.kind === 'day') setDayDrawer(o.date);
    else setDialog(o);
  }, []);

  const ctx: CalendarCtx | null = data ? { data, matcher, hl, toggleHighlight, open } : null;

  // The occurrence behind the open drawer, from the loaded range (it follows every refetch).
  const findOcc = (key: string): RouteOccurrence | TaskOccurrence | undefined =>
    data?.routes.find((o) => o.key === key) ?? data?.tasks.find((o) => o.key === key);
  const drawerOcc = drawer ? findOcc(drawer.key) : undefined;
  // Close a drawer whose occurrence is gone after a refetch (deleted, split or moved). A drawer opened for a
  // route that was just created waits for the first refetch after it was opened.
  useEffect(() => {
    if (!drawer || !data) return;
    if (findOcc(drawer.key)) {
      if (drawer.since) setDrawer({ kind: drawer.kind, key: drawer.key } as DrawerOverlay);
    } else if (!q.isPlaceholderData && !q.isFetching && (!drawer.since || q.dataUpdatedAt > drawer.since)) {
      setDrawer(null);
    }
  }, [drawer, data, q.isPlaceholderData, q.isFetching, q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Title: "2026年11月" / "November 2026" (month bold, year regular); the week view adds its date range.
  let title = null;
  if (data) {
    const ref = view === 'week' ? data.days[3]?.date ?? data.from : data.days.find((d) => d.in_month)?.date ?? data.from;
    const y = ref.slice(0, 4);
    const m = monthName(Number(ref.slice(5, 7)), lang);
    title = (
      <>
        {lang === 'zh' ? (
          <>
            <span className="y">{y}年</span>
            <b>{m}</b>
          </>
        ) : (
          <>
            <b>{m}</b> <span className="y">{y}</span>
          </>
        )}
        {view === 'week' && <small className="wk">{`${fmtDay(data.from, lang, { weekday: false })} – ${fmtDay(data.to, lang, { weekday: false })}`}</small>}
      </>
    );
  }
  const dayGroup = dayDrawer ? groups.find((g) => g.day.date === dayDrawer) : undefined;

  return (
    <>
      <div className="cal-bar cal-top">
        <h1 className="range cal-title num" aria-live="polite">
          {title}
        </h1>
        <span className="spacer" />
        <div className="calnav" role="group">
          <button type="button" className="btn" aria-label={t('cal.prev')} title={t('cal.prev')} onClick={() => data && setNav(view, data.prev_anchor)}>
            ‹
          </button>
          <button type="button" className="btn" onClick={() => setNav(view, '')}>
            {t('common.today')}
          </button>
          <button type="button" className="btn" aria-label={t('cal.next')} title={t('cal.next')} onClick={() => data && setNav(view, data.next_anchor)}>
            ›
          </button>
        </div>
        <div className="seg" role="group" aria-label={t('cal.view')}>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setNav('week', anchor)}>
            {t('cal.week')}
          </button>
          <button type="button" aria-pressed={view === 'month'} onClick={() => setNav('month', anchor)}>
            {t('cal.month')}
          </button>
        </div>
        <button type="button" className="btn urgent" onClick={() => open({ kind: 'urgent' })}>
          ⚡ {t('urgent.title')}
        </button>
        <button type="button" className="btn" onClick={() => open({ kind: 'taskCreate' })}>
          {t('cal.addTask')}
        </button>
      </div>

      {data && data.missing_holiday_years.length > 0 && (
        <div className="banner warn row">
          <span>{t('holidays.missing', { years: data.missing_holiday_years.join(', ') })}</span>
          <Link to="/holidays">{t('nav.holidays')}</Link>
        </div>
      )}

      <div className="cal-bar">
        <input
          className="search"
          type="search"
          value={search}
          placeholder={t('cal.searchPlaceholder')}
          aria-label={t('common.search')}
          onChange={(e) => {
            setSearch(e.target.value);
            setHl(null);
          }}
        />
        {(['regular', 'special', 'adhoc'] as RouteType[]).map((ty) => (
          <button key={ty} type="button" className="tchip" aria-pressed={types[ty]} onClick={() => setTypes((s) => ({ ...s, [ty]: !s[ty] }))}>
            <span className={ty === 'adhoc' ? 'tt A' : 'tt'}>{ty === 'regular' ? 'R' : ty === 'special' ? 'S' : '⚡A'}</span>
            {t(`type.${ty}`)}
          </button>
        ))}
        {taskTypes.map((w) => {
          const on = !hiddenTaskTypes.includes(w.code);
          return (
            <button
              key={w.code}
              type="button"
              className="tchip"
              aria-pressed={on}
              title={t('cal.taskChip', { type: w.name })}
              onClick={() => setHiddenTaskTypes((s) => (on ? [...s, w.code] : s.filter((c) => c !== w.code)))}
            >
              <span className="wtag">{w.abbr || w.code}</span>
              {t('cal.tasks')}
            </button>
          );
        })}
        {(hl || search) && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setHl(null);
              setSearch('');
            }}
          >
            {t('cal.clearHighlight')}
          </button>
        )}
        {q.isFetching && <span className="muted small">{t('app.loading')}</span>}
        {view === 'month' && (
          <button
            type="button"
            className="btn small expall"
            aria-pressed={allOpen}
            disabled={collapsible.length === 0}
            onClick={() => setExpanded((s) => (allOpen ? {} : { ...s, ...Object.fromEntries(collapsible.map((d) => [d, true])) }))}
          >
            {allOpen ? `${t('cal.collapseAll')} ▴` : `${t('cal.expandAll')} ▾`}
          </button>
        )}
      </div>

      {legend.length > 0 && (
        <div className="legend" aria-label={t('cal.legend')}>
          {legend.map((l) => (
            <button
              key={l.code}
              type="button"
              className={['lchip', l.type === 'adhoc' ? 'adhoc' : '', hl === l.code ? 'on' : '', matcher.active && !matcher.code(l.code) ? 'dim' : ''].filter(Boolean).join(' ')}
              style={rcStyle(l.color)}
              title={l.name}
              aria-pressed={hl === l.code}
              data-code={l.code}
              onClick={() => toggleHighlight(l.code)}
            >
              <span className="code">
                {l.type === 'adhoc' ? '⚡' : ''}
                {l.code}
              </span>
              <span className="ln">{shortName(l.name)}</span>
            </button>
          ))}
        </div>
      )}

      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {!data && q.isLoading && <Loading />}

      {ctx && (
        <CalendarContext.Provider value={ctx}>
          {view === 'week' ? <WeekView groups={groups} /> : <MonthView groups={groups} expanded={expanded} onToggle={toggleCell} />}

          <Drawer
            open={!!dayGroup}
            onClose={() => setDayDrawer(null)}
            label={dayGroup ? fmtDay(dayGroup.day.date, lang) : ''}
            title={<h2>{dayGroup ? fmtDay(dayGroup.day.date, lang, { year: true }) : ''}</h2>}
            header={
              dayGroup &&
              view === 'month' && (
                <div className="row">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setDayDrawer(null);
                      setNav('week', dayGroup.day.date);
                    }}
                  >
                    {t('cal.openWeek')}
                  </button>
                </div>
              )
            }
          >
            {dayGroup && (
              <div className="daydrawer">
                <DayColumn g={dayGroup} dispatch />
              </div>
            )}
          </Drawer>

          {drawerOcc?.kind === 'route' && <RouteDrawer key={drawerOcc.key} occ={drawerOcc} onClose={() => setDrawer(null)} />}
          {drawerOcc?.kind === 'task' && <TaskDrawer key={drawerOcc.key} occ={drawerOcc} onClose={() => setDrawer(null)} />}

          {dialog?.kind === 'copy' && <CopyDialog occ={dialog.occ} mode={dialog.mode} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'routeCreate' && (
            <RouteForm
              mode="create"
              createType={dialog.type}
              date={dialog.date}
              dow={dialog.dow}
              onClose={() => setDialog(null)}
              onCreated={(r, date) => {
                setDialog(null);
                if (date) setDrawer({ kind: 'route', key: `r${r.id}@${date}`, since: Date.now() });
              }}
            />
          )}
          {dialog?.kind === 'urgent' && (
            <UrgentDialog
              initialDate={dialog.date}
              initialCustomers={dialog.customers}
              onClose={() => setDialog(null)}
              onTaskInstead={() => setDialog({ kind: 'taskCreate', date: undefined })}
            />
          )}
          {dialog?.kind === 'taskCreate' && <TaskDialog mode="create" date={dialog.date} onClose={() => setDialog(null)} />}
        </CalendarContext.Provider>
      )}
    </>
  );
}

