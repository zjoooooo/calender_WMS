// Week view (7 day columns, Sunday first), the day column (also used by the day drawer), one-line route and
// task rows, the collapsible tasks group, the paused (PH) group, and the month grid (§9.2, §8.3): Sunday
// first, one line per route / task, holiday bar, "N more" collapse past 4 lines, "+" create menu.
// Today's date is blue, a public holiday's date red (both views).
import { useState, type KeyboardEvent } from 'react';
import type { CalendarDay, RouteOccurrence, TaskOccurrence } from '../api';
import { fmtDay, fmtMonthStart, fmtTime, useI18n, weekdayName } from '../i18n';
import { useSession } from '../session';
import { rcStyle } from '../ui/palette';
import { StatusGlyph } from '../ui/StatusGlyph';
import { TypeTag } from '../ui/Chip';
import { useCalendar, type CreateKind } from './calendarContext';
import { dispatchSort, monthCellLines, monthWeeks, pausedCounts, taskGroupCounts, type DayGroups } from './calendarModel';
import { MenuButton, opsText, runDetailText, totalsText, type MenuItem } from './officeShared';

const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/** Holder while active, last holder when done (§8.3 "✓ Ali 8/8"). */
function driverName(o: RouteOccurrence | TaskOccurrence): string | null {
  const r = o.run;
  if (!r) return null;
  return r.driver?.name ?? (r.holders.length ? r.holders[r.holders.length - 1] : null);
}

export function WeekView({ groups }: { groups: DayGroups[] }) {
  return (
    <div className="week">
      {groups.map((g) => (
        <DayColumn key={g.day.date} g={g} />
      ))}
    </div>
  );
}

export function DayHeader({ day, g }: { day: CalendarDay; g: DayGroups }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { data, open } = useCalendar();
  const isToday = day.date === data.today;
  // Between 00:00 and the rollover the Today tag stays on the previous date: "Today · until 04:00".
  const night = !!meta && meta.rollover_hour > 0 && meta.day_ends_at.slice(0, 10) === meta.now.slice(0, 10);
  const s = g.summary;
  const sum = [t('cal.nRoutes', { n: s.routes }), t('cal.nStops', { n: s.stops }), t('cal.nTasks', { n: s.tasks })];
  if (s.paused) sum.push(t('cal.nPaused', { n: s.paused }));
  const totals = totalsText(day.totals, meta?.waste_types);
  return (
    <div className="dh">
      <div className="d1">
        <span className="dow">{weekdayName(day.dow, lang)}</span>
        <button type="button" className={dateCls('dt', isToday, day)} onClick={() => open({ kind: 'day', date: day.date })} title={t('cal.openDay')}>
          {fmtDay(day.date, lang, { weekday: false })}
        </button>
        {isToday ? (
          <span className="todaytag">{night && meta ? t('cal.todayUntil', { time: fmtTime(meta.day_ends_at) }) : t('common.today')}</span>
        ) : day.past ? (
          <span className="lock">🔒 {t('cal.readOnly')}</span>
        ) : null}
      </div>
      {day.holiday && <span className="phtag" title={day.holiday}>{t('cal.ph', { name: day.holiday })}</span>}
      <span className="sum num">{sum.join(' · ')}</span>
      {day.ops && opsText(day.ops, day.past) && <span className="opsline num">{opsText(day.ops, day.past)}</span>}
      {(isToday || day.past) && totals && (
        <span className="totals num">
          {totals}
          {day.provisional ? ` · ${t('cal.provisional')}` : ''}
        </span>
      )}
    </div>
  );
}

/** One day: header, tasks group, routes, paused group and the [+ Route] [+ Task] footer. */
export function DayColumn({ g, dispatch }: { g: DayGroups; dispatch?: boolean }) {
  const { t } = useI18n();
  const { data, matcher } = useCalendar();
  const day = g.day;
  const routes = dispatch && day.date === data.today ? dispatchSort(g.routes) : g.routes;
  const cls = ['day', day.class === 'rest' ? 'rest' : '', day.date === data.today ? 'today' : '', day.past ? 'past' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label={day.date} data-date={day.date}>
      <DayHeader day={day} g={g} />
      <div className="occs">
        {g.tasks.length > 0 && <TasksBox tasks={dispatch && day.date === data.today ? dispatchSort(g.tasks) : g.tasks} matcher={matcher} />}
        {routes.map((o) => (
          <RouteRow key={o.key} o={o} />
        ))}
        {routes.length === 0 && g.tasks.length === 0 && g.paused.length === 0 && <div className="empty-day">{t('cal.noRoutes')}</div>}
      </div>
      {g.paused.length > 0 && <PausedGroup list={g.paused} />}
      {!day.past && <DayFooter day={day} />}
    </section>
  );
}

/** Day number / date classes: today (blue circle) wins over a public holiday (red). */
function dateCls(base: string, isToday: boolean, day: CalendarDay): string {
  return [base, isToday ? 'today' : '', day.holiday ? 'ph' : ''].filter(Boolean).join(' ');
}

/** What a day lets the office create (§6.6, the server's can_create): the route kinds and + Task. */
function useCreateItems(day: CalendarDay): { routes: MenuItem[]; task: MenuItem | null } {
  const { t } = useI18n();
  const { open } = useCalendar();
  const label: Record<CreateKind, string> = {
    regular: t('cal.addRegular'),
    adhoc: t('cal.addAdhoc'),
    special: t('cal.addSpecial'),
    special_once: t('cal.addSpecialOnce'),
  };
  const kinds = day.can_create.filter((k) => k !== 'task') as CreateKind[];
  return {
    routes: kinds.map((k) => ({ label: label[k], onClick: () => open({ kind: 'routeCreate', date: day.date, type: k, dow: day.dow }) })),
    task: day.can_create.includes('task') ? { label: t('cal.addTask'), onClick: () => open({ kind: 'taskCreate', date: day.date }) } : null,
  };
}

function DayFooter({ day }: { day: CalendarDay }) {
  const { t } = useI18n();
  const { routes, task } = useCreateItems(day);
  return (
    <div className="day-foot">
      {routes.length > 0 && <MenuButton className="addr" align="left" label={t('cal.addRoute')} items={routes} />}
      {task && (
        <button type="button" className="addr" onClick={task.onClick}>
          {task.label}
        </button>
      )}
    </div>
  );
}

export function RouteRow({ o, paused }: { o: RouteOccurrence; paused?: boolean }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { matcher, toggleHighlight, open, data } = useCalendar();
  const dim = matcher.active && !matcher.route(o);
  const run = o.run;
  const resolved = run ? run.collected + run.missed : 0;
  const total = run ? run.total : o.stops.length;
  const covered = o.covered_by.map((c) => `→ ${c.code} ${fmtDay(c.date, lang)}`).join(', ');
  let status;
  if (o.status === 'cancelled') {
    status = <span className="sg cancelled">{covered || t('status.cancelled')}</span>;
  } else if (o.status === 'holiday_skipped') {
    status = <span className="sg">{covered || `⏸ ${t('status.holiday_skipped')}`}</span>;
  } else {
    status = (
      <StatusGlyph
        status={o.run_status}
        driver={driverName(o)}
        resolved={resolved}
        total={total}
        title={runDetailText(o.run_status, run, t, meta?.waste_types, meta?.now)}
      />
    );
  }
  const cls = ['occ', o.type === 'adhoc' ? 'adhoc' : '', o.status === 'cancelled' ? 'cancelled' : '', o.orphan ? 'orphan' : '', dim ? 'dim' : ''].filter(Boolean).join(' ');
  const showPg = o.date <= data.today && run && total > 0 && o.status === 'scheduled';
  return (
    <div
      className={cls}
      style={rcStyle(o.color)}
      role="button"
      tabIndex={0}
      data-key={o.key}
      data-code={o.code}
      aria-label={`${o.code} ${o.name}`}
      title={o.name}
      onClick={() => open({ kind: 'route', key: o.key })}
      onKeyDown={onEnter(() => open({ kind: 'route', key: o.key }))}
    >
      <button
        type="button"
        className="code"
        title={t('cal.highlightCode', { code: o.code })}
        onClick={(e) => {
          e.stopPropagation();
          toggleHighlight(o.code);
        }}
      >
        {o.code}
      </button>
      <TypeTag type={o.type} />
      <span className="nm">{o.name}</span>
      {o.edited && !paused && (
        <span className="ed" title={t('cal.edited')} aria-label={t('cal.edited')}>
          ✎
        </span>
      )}
      <span className="st">{status}</span>
      {showPg && (
        <span className="pg" aria-hidden="true">
          <i style={{ width: `${Math.round((resolved / total) * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

export function TaskRow({ o }: { o: TaskOccurrence }) {
  const { t } = useI18n();
  const { meta } = useSession();
  const { matcher, open, data } = useCalendar();
  const dim = matcher.active && !matcher.task(o);
  const cust = data.customers[String(o.customer_id)];
  const wt = meta?.waste_types.find((w) => w.code === o.waste_type);
  const cls = ['trow', o.status === 'cancelled' ? 'cancelled' : '', dim ? 'dim' : ''].filter(Boolean).join(' ');
  const covered = o.covered_by.map((c) => `→ ${fmtDay(c.date, 'en')}`).join(', ');
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      data-key={o.key}
      aria-label={`${o.waste_type} ${cust?.name ?? ''}`}
      onClick={() => open({ kind: 'task', key: o.key })}
      onKeyDown={onEnter(() => open({ kind: 'task', key: o.key }))}
      title={o.note || cust?.name}
    >
      <span className="wtag">{wt?.abbr || o.waste_type}</span>
      {o.recurring && <span className="rec" title={t('task.recurring')}>↻</span>}
      <span className="nm">{cust?.name ?? `#${o.customer_id}`}</span>
      {o.status === 'cancelled' ? (
        <span className="sg cancelled">{covered || t('status.cancelled')}</span>
      ) : (
        <StatusGlyph
          status={o.run_status}
          kind="task"
          driver={driverName(o)}
          notCollected={o.visit?.outcome === 'missed'}
          title={runDetailText(o.run_status, o.run, t, meta?.waste_types, meta?.now)}
        />
      )}
    </div>
  );
}

/** ≤ 3 tasks: one row each; more: one collapsed line that expands in place (auto when search matches). */
function TasksBox({ tasks, matcher }: { tasks: TaskOccurrence[]; matcher: ReturnType<typeof useCalendar>['matcher'] }) {
  const { t } = useI18n();
  const { meta } = useSession();
  const [open, setOpen] = useState(false);
  const autoOpen = matcher.active && tasks.some(matcher.task);
  const expanded = tasks.length <= 3 || open || autoOpen;
  const counts = taskGroupCounts(tasks);
  const abbr = (code: string) => meta?.waste_types.find((w) => w.code === code)?.abbr || code;
  const line = [t('cal.tasksN', { n: tasks.length }), ...counts.byType.map(([c, n]) => `${abbr(c)} ${n}`)];
  if (counts.unclaimed) line.push(`○${counts.unclaimed} ${t('status.not_started')}`);
  return (
    <div className="tasks-box">
      {tasks.length > 3 && (
        <button type="button" className={matcher.active && !autoOpen ? 'tgroup dim' : 'tgroup'} aria-expanded={expanded} onClick={() => setOpen((v) => !v)}>
          ▣ {line.join(' · ')} {expanded ? '▾' : '▸'}
        </button>
      )}
      {expanded && tasks.map((o) => <TaskRow key={o.key} o={o} />)}
    </div>
  );
}

/** "11 regular routes paused (PH) · 2 covered": the count is what still needs a decision (§6.4). */
function pausedLabel(list: RouteOccurrence[], t: (k: string, v?: Record<string, string | number>) => string): string {
  const c = pausedCounts(list);
  if (c.open === 0) return t('cal.pausedAllCovered', { n: c.covered });
  return [t('cal.pausedN', { n: c.open }), c.covered ? t('cal.nCovered', { n: c.covered }) : ''].filter(Boolean).join(' · ');
}

function PausedGroup({ list }: { list: RouteOccurrence[] }) {
  const { t } = useI18n();
  const { open } = useCalendar();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button type="button" className="paused" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        ⏸ {pausedLabel(list, t)} {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div className="pausedlist">
          {list.map((o) => (
            <div key={o.key}>
              {/* a covered row shows its "→ N1-25 Fri 25 Dec" once, as the row's status */}
              <RouteRow o={o} paused />
              {o.covered_by.length === 0 && !o.frozen && (
                <div className="paused-acts">
                  <button type="button" className="btn small" onClick={() => open({ kind: 'copy', occ: o, mode: 'ph' })}>
                    {t('copy.runOnPh')}
                  </button>
                  <button type="button" className="btn small" onClick={() => open({ kind: 'copy', occ: o, mode: 'move' })}>
                    {t('copy.moveWorkDay')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- month (§9.2) ----------------------------------------------------------------------------------

/**
 * Month grid in the style of a desktop calendar: weekday header (Sunday first, from the server's days), the
 * week rows that hold a day of the month (4–6), one line per route / task, collapse past 4 lines.
 * `expanded` (per date) lives in the page so the 30 s refetch never collapses a cell.
 */
export function MonthView({ groups, expanded, onToggle }: { groups: DayGroups[]; expanded: Record<string, boolean>; onToggle: (date: string, open: boolean) => void }) {
  const { lang } = useI18n();
  const weeks = monthWeeks(groups);
  return (
    <div className="month" data-rows={weeks.length}>
      {groups.slice(0, 7).map((g) => (
        <div key={g.day.dow} className="mh">
          {weekdayName(g.day.dow, lang)}
        </div>
      ))}
      {weeks.flat().map((g, i) => (
        <MonthCell key={g.day.date} g={g} col={i % 7} expanded={!!expanded[g.day.date]} onToggle={onToggle} />
      ))}
    </div>
  );
}

function MonthCell({ g, col, expanded, onToggle }: { g: DayGroups; col: number; expanded: boolean; onToggle: (date: string, open: boolean) => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { data, matcher, open } = useCalendar();
  const day = g.day;
  const isToday = day.date === data.today;
  const lines = monthCellLines(g, expanded, matcher);
  const cls = ['mcell', day.in_month ? '' : 'out', day.past ? 'past' : '', isToday ? 'today' : '', day.holiday ? 'ph' : ''].filter(Boolean).join(' ');
  const abbr = (code: string) => meta?.waste_types.find((w) => w.code === code)?.abbr || code;
  const hiddenList = lines.hidden
    .map((o) => (o.kind === 'route' ? o.code : `${abbr(o.waste_type)} ${data.customers[String(o.customer_id)]?.name ?? ''}`))
    .join(', ');
  const pausedDim = matcher.active && !g.paused.some(matcher.route);
  const pc = pausedCounts(g.paused);
  // Daily totals per waste type (Round 4 "reports in v1"), today and past days, as in the week header.
  const totals = isToday || day.past ? totalsText(day.totals, meta?.waste_types) : '';
  const totalsTip = totals ? `${totals}${day.provisional ? ` · ${t('cal.provisional')}` : ''}` : '';
  const pausedText = [pc.open ? t('cal.nPaused', { n: pc.open }) : '', pc.covered ? t('cal.nCovered', { n: pc.covered }) : ''].filter(Boolean).join(' · ');
  return (
    <div className={cls} data-date={day.date}>
      <div className="mtop">
        {day.can_create.length > 0 && <MonthAdd day={day} right={col >= 4} />}
        {totals && (
          <span className="mtot num" title={totalsTip} data-testid="month-totals">
            {totals}
          </span>
        )}
        <button
          type="button"
          className={dateCls('dnum', isToday, day)}
          onClick={() => open({ kind: 'day', date: day.date })}
          title={`${fmtDay(day.date, lang)} · ${t('cal.openDay')}`}
          aria-label={`${fmtDay(day.date, lang, { year: true })}${isToday ? ' · ' + t('common.today') : ''}${day.holiday ? ' · ' + day.holiday : ''}`}
        >
          {day.date.endsWith('-01') ? fmtMonthStart(day.date, lang) : Number(day.date.slice(8))}
        </button>
      </div>
      {day.holiday && (
        <div className="mph" title={t('cal.ph', { name: day.holiday })}>
          <span aria-hidden="true">★ </span>
          {day.holiday}
        </div>
      )}
      {g.paused.length > 0 && (
        <button type="button" className={pausedDim ? 'mpaused dim' : 'mpaused'} title={pausedLabel(g.paused, t)} onClick={() => open({ kind: 'day', date: day.date })}>
          ⏸ {pausedText} ▸
        </button>
      )}
      <div className="mlines">
        {lines.shown.map((o) => (o.kind === 'route' ? <MonthRouteLine key={o.key} o={o} /> : <MonthTaskLine key={o.key} o={o} />))}
        {lines.collapsible && !lines.open && (
          <button type="button" className="mmore" aria-expanded={false} title={t('cal.moreTip', { list: hiddenList })} onClick={() => onToggle(day.date, true)}>
            {t('cal.moreN', { n: lines.hidden.length })} ▾
          </button>
        )}
        {lines.collapsible && lines.open && !lines.auto && (
          <button type="button" className="mmore" aria-expanded={true} onClick={() => onToggle(day.date, false)}>
            {t('cal.showLess')} ▴
          </button>
        )}
      </div>
    </div>
  );
}

/** "+" at the cell's top-left: the same create menu as the week view's footer. */
function MonthAdd({ day, right }: { day: CalendarDay; right: boolean }) {
  const { t, lang } = useI18n();
  const { routes, task } = useCreateItems(day);
  const items: (MenuItem | null)[] = [...routes, ...(routes.length && task ? [null] : []), ...(task ? [task] : [])];
  if (!items.length) return null;
  return <MenuButton className="madd" align={right ? 'right' : 'left'} label="+" title={t('cal.addOn', { date: fmtDay(day.date, lang) })} items={items} />;
}

/** One route line: colour bar, CODE, type tag, name (truncated first), short status (§8.3) at the right. */
function MonthRouteLine({ o }: { o: RouteOccurrence }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { matcher, open } = useCalendar();
  const dim = matcher.active && !matcher.route(o);
  const run = o.run;
  const resolved = run ? run.collected + run.missed : 0;
  const total = run ? run.total : o.stops.length;
  const detail = o.status === 'scheduled' ? runDetailText(o.run_status, run, t, meta?.waste_types, meta?.now) : '';
  const covered = o.covered_by.map((c) => `→ ${c.code} ${fmtDay(c.date, lang)}`).join(', ');
  const status =
    o.status === 'cancelled' ? (
      <span className="sg cancelled">{o.covered_by.length ? `→ ${o.covered_by[0].code}` : t('status.cancelled')}</span>
    ) : (
      <StatusGlyph compact status={o.run_status} driver={driverName(o)} resolved={resolved} total={total} title={detail} />
    );
  const cls = ['mline', o.type === 'adhoc' ? 'adhoc' : '', o.status === 'cancelled' ? 'cancelled' : '', o.orphan ? 'orphan' : '', dim ? 'dim' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      style={rcStyle(o.color)}
      data-key={o.key}
      data-code={o.code}
      title={[`${o.code} · ${o.name}`, covered || detail].filter(Boolean).join('\n')}
      onClick={() => open({ kind: 'route', key: o.key })}
    >
      <span className="code">{o.code}</span>
      <TypeTag type={o.type} />
      <span className="nm">{o.name}</span>
      <span className="st">{status}</span>
    </button>
  );
}

/** One task line: grey pill, waste-type tag, ↻ when recurring, customer, short status. */
function MonthTaskLine({ o }: { o: TaskOccurrence }) {
  const { t } = useI18n();
  const { meta } = useSession();
  const { matcher, open, data } = useCalendar();
  const dim = matcher.active && !matcher.task(o);
  const cust = data.customers[String(o.customer_id)];
  const tag = meta?.waste_types.find((w) => w.code === o.waste_type)?.abbr || o.waste_type;
  const cls = ['mline', 'task', o.status === 'cancelled' ? 'cancelled' : '', dim ? 'dim' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      data-key={o.key}
      title={[`${tag} · ${cust?.name ?? ''}`, o.note].filter(Boolean).join('\n')}
      onClick={() => open({ kind: 'task', key: o.key })}
    >
      <span className="wtag">{tag}</span>
      {o.recurring && (
        <span className="rec" title={t('task.recurring')}>
          ↻
        </span>
      )}
      <span className="nm">{cust?.name ?? `#${o.customer_id}`}</span>
      <span className="st">
        {o.status === 'cancelled' ? (
          <span className="sg cancelled">{t('status.cancelled')}</span>
        ) : (
          <StatusGlyph
            compact
            kind="task"
            status={o.run_status}
            driver={driverName(o)}
            notCollected={o.visit?.outcome === 'missed'}
            title={runDetailText(o.run_status, o.run, t, meta?.waste_types, meta?.now)}
          />
        )}
      </span>
    </button>
  );
}
