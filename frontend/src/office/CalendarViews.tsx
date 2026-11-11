// Week view (7 day columns), the day column (also used by the day drawer), one-line route and task rows,
// the collapsible tasks group, the paused (PH) group and the month grid with code chips (§9.2, §8.3).
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { CalendarDay, RouteOccurrence, TaskOccurrence } from '../api';
import { fmtDay, fmtTime, useI18n, weekdayName } from '../i18n';
import { useSession } from '../session';
import { rcStyle } from '../ui/palette';
import { StatusGlyph } from '../ui/StatusGlyph';
import { TypeTag } from '../ui/Chip';
import { useCalendar, type CreateKind } from './calendarContext';
import { dispatchSort, statusDot, taskGroupCounts, type DayGroups } from './calendarModel';
import { MenuButton, opsText, runDetailText, totalsText } from './officeShared';

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
        <button type="button" className="dt" onClick={() => open({ kind: 'day', date: day.date })} title={t('cal.openDay')}>
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

function DayFooter({ day }: { day: CalendarDay }) {
  const { t } = useI18n();
  const { open } = useCalendar();
  const kinds = day.can_create.filter((k) => k !== 'task') as CreateKind[];
  const label: Record<CreateKind, string> = {
    regular: t('cal.addRegular'),
    adhoc: t('cal.addAdhoc'),
    special: t('cal.addSpecial'),
    special_once: t('cal.addSpecialOnce'),
  };
  return (
    <div className="day-foot">
      {kinds.length > 0 && (
        <MenuButton
          className="addr"
          align="left"
          label={t('cal.addRoute')}
          items={kinds.map((k) => ({ label: label[k], onClick: () => open({ kind: 'routeCreate', date: day.date, type: k, dow: day.dow }) }))}
        />
      )}
      {day.can_create.includes('task') && (
        <button type="button" className="addr" onClick={() => open({ kind: 'taskCreate', date: day.date })}>
          {t('cal.addTask')}
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

function PausedGroup({ list }: { list: RouteOccurrence[] }) {
  const { t, lang } = useI18n();
  const { open } = useCalendar();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button type="button" className="paused" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        ⏸ {t('cal.pausedN', { n: list.length })} {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div className="pausedlist">
          {list.map((o) => (
            <div key={o.key}>
              <RouteRow o={o} paused />
              {o.covered_by.length > 0 ? (
                <div className="covered">{o.covered_by.map((c) => `→ ${c.code} ${fmtDay(c.date, lang)}`).join(', ')}</div>
              ) : (
                !o.frozen && (
                  <div className="paused-acts">
                    <button type="button" className="btn small" onClick={() => open({ kind: 'copy', occ: o, mode: 'ph' })}>
                      {t('copy.runOnPh')}
                    </button>
                    <button type="button" className="btn small" onClick={() => open({ kind: 'copy', occ: o, mode: 'move' })}>
                      {t('copy.moveWorkDay')}
                    </button>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- month -----------------------------------------------------------------------------------------

export function MonthView({ groups }: { groups: DayGroups[] }) {
  const { lang } = useI18n();
  return (
    <div className="month">
      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
        <div key={d} className="mh">
          {weekdayName(d, lang)}
        </div>
      ))}
      {groups.map((g) => (
        <MonthCell key={g.day.date} g={g} />
      ))}
    </div>
  );
}

function MonthCell({ g }: { g: DayGroups }) {
  const { t, lang } = useI18n();
  const { data, matcher, open } = useCalendar();
  const day = g.day;
  const showDots = day.date <= data.today;
  const cls = ['mcell', day.class === 'rest' ? 'rest' : '', day.in_month ? '' : 'out', day.past ? 'past' : '', day.date === data.today ? 'today' : '']
    .filter(Boolean)
    .join(' ');
  const tasks = g.tasks;
  const taskAlert =
    day.date === data.today ? tasks.some((o) => o.run_status === 'not_started') : day.past && tasks.some((o) => o.run_status === 'incomplete' || o.run_status === 'no_record');
  const taskTip = tasks.map((o) => `${o.waste_type} ${data.customers[String(o.customer_id)]?.name ?? ''}${o.status === 'cancelled' ? ' (' + t('status.cancelled') + ')' : ''}`).join('\n');
  const tasksDim = matcher.active && !tasks.some(matcher.task);
  return (
    <div className={cls} data-date={day.date}>
      <div className="mtop">
        <button type="button" className="dnum" onClick={() => open({ kind: 'day', date: day.date })} title={fmtDay(day.date, lang)}>
          {Number(day.date.slice(8))}
        </button>
        {day.holiday && <span className="phtag" title={day.holiday}>{day.holiday}</span>}
        <span className="cnt num">{t('cal.nRoutes', { n: g.summary.routes })}</span>
      </div>
      <div className="mchips">
        {g.routes.map((o) => {
          const dot = showDots && o.status === 'scheduled' ? statusDot(o.run_status) : null;
          const c = ['mchip', o.type === 'adhoc' ? 'adhoc' : '', o.status === 'cancelled' ? 'cancelled' : '', matcher.active && !matcher.route(o) ? 'dim' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <button key={o.key} type="button" className={c} style={rcStyle(o.color) as CSSProperties} title={`${o.code} ${o.name}`} data-key={o.key} onClick={() => open({ kind: 'route', key: o.key })}>
              {o.type === 'adhoc' ? '⚡' : ''}
              {o.code}
              {dot && <span className={`dot ${dot}`} aria-label={t(`status.${o.run_status}`)} />}
            </button>
          );
        })}
        {g.paused.length > 0 && (
          <button type="button" className="mchip paused" title={t('cal.pausedN', { n: g.paused.length })} onClick={() => open({ kind: 'day', date: day.date })}>
            ⏸{g.paused.length}
          </button>
        )}
        {tasks.length > 0 && (
          <button type="button" className={tasksDim ? 'mchip task dim' : 'mchip task'} title={taskTip} onClick={() => open({ kind: 'day', date: day.date })}>
            ▣ {tasks.length}
            {taskAlert && <span className="dot warn" />}
          </button>
        )}
      </div>
    </div>
  );
}
