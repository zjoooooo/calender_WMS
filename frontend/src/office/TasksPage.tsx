// Tasks page (§9.2): table (type, customer, schedule "Once Sat 15 Nov" / "Tue, Fri from 17 Nov", end,
// next date, note, today's status); filters: type, one-off or recurring, active or ended; actions Edit,
// End (recurring), Delete; [+ Task].
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deleteTask, listTasks, patchTask, type TaskListItem } from '../api';
import { fmtDay, useI18n } from '../i18n';
import { useSession } from '../session';
import { ConfirmDialog } from '../ui/Dialog';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { addDays } from './calendarModel';
import { EndDialog } from './CopyDialog';
import { taskScheduleText } from './labels';
import { MenuButton, useGuardedWrite } from './officeShared';
import { TaskDialog } from './TaskDialog';
import './office.css';

type Dlg = { kind: 'create' } | { kind: 'edit'; id: number } | { kind: 'end'; r: TaskListItem } | { kind: 'delete'; r: TaskListItem };

export default function TasksPage() {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const toast = useToast();
  const w = useGuardedWrite();
  const [type, setType] = useState('');
  const [kind, setKind] = useState<'' | 'one_off' | 'recurring'>('');
  const [ended, setEnded] = useState(false);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const q = useQuery({
    queryKey: ['tasks', { type, kind, ended }],
    queryFn: () => listTasks({ type: type || undefined, kind: kind || undefined, ended }),
  });
  const today = meta?.today ?? '';
  const types = (meta?.waste_types ?? []).filter((x) => !x.routable);
  const abbr = (code: string) => types.find((x) => x.code === code)?.abbr || code;
  const sched = (r: TaskListItem) =>
    taskScheduleText(r.date ? { date: r.date } : { start: r.start ?? null, end: null, days: r.days ?? [] }, t, lang);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.tasks')}</h1>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('task.type')}>
          <option value="">{t('tasks.allTypes')}</option>
          {types.map((x) => (
            <option key={x.code} value={x.code}>
              {x.abbr || x.code}
            </option>
          ))}
        </select>
        <div className="seg" role="group" aria-label={t('tasks.kind')}>
          <button type="button" aria-pressed={kind === ''} onClick={() => setKind('')}>
            {t('common.all')}
          </button>
          <button type="button" aria-pressed={kind === 'one_off'} onClick={() => setKind('one_off')}>
            {t('task.once')}
          </button>
          <button type="button" aria-pressed={kind === 'recurring'} onClick={() => setKind('recurring')}>
            ↻ {t('task.recurring')}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} /> {t('tasks.showEnded')}
        </label>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => setDlg({ kind: 'create' })}>
          {t('cal.addTask')}
        </button>
      </div>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('task.type')}</th>
                <th>{t('task.customer')}</th>
                <th>{t('routes.colSchedule')}</th>
                <th>{t('rf.end')}</th>
                <th>{t('routes.colNext')}</th>
                <th>{t('common.note')}</th>
                <th>{t('routes.colToday')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id} className={r.ended ? 'dim clickable' : 'clickable'} onClick={() => setDlg({ kind: 'edit', id: r.id })}>
                  <td>
                    <span className="wtag">{abbr(r.waste_type)}</span> {r.days ? '↻' : ''}
                  </td>
                  <td>
                    {r.customer.name} <span className="muted small code">{r.customer.code}</span>
                  </td>
                  <td className="small">{sched(r)}</td>
                  <td className="small nowrap">{r.end ? fmtDay(r.end, lang) : '–'}</td>
                  <td className="small nowrap">{r.next_date ? fmtDay(r.next_date, lang) : '–'}</td>
                  <td className="small">{r.note}</td>
                  <td className="small">{r.today_status ? t(`status.${r.today_status}`) : '–'}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    <MenuButton
                      className="btn small"
                      label="⋯"
                      items={[
                        { label: t('common.edit'), onClick: () => setDlg({ kind: 'edit', id: r.id }) },
                        ...(r.days && !r.ended ? [{ label: t('task.endSeries'), onClick: () => setDlg({ kind: 'end', r }) }] : []),
                        { label: t('common.delete'), onClick: () => setDlg({ kind: 'delete', r }), danger: true },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {q.data.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t('tasks.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {dlg?.kind === 'create' && <TaskDialog mode="create" onClose={() => setDlg(null)} />}
      {dlg?.kind === 'edit' && <TaskDialog mode="edit" taskId={dlg.id} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'end' && (
        <EndDialog
          title={t('task.endSeries')}
          initial={dlg.r.next_date ?? today}
          min={today}
          busy={w.busy}
          error={w.error}
          onSubmit={(from) =>
            void w.run(
              (rel) => patchTask(dlg.r.id, { rev: dlg.r.rev, end: addDays(from, -1), ...(rel ? { release_run: true } : {}) }),
              () => {
                toast(t('rd.ended', { date: fmtDay(from, lang) }));
                setDlg(null);
              },
            )
          }
          onClose={() => setDlg(null)}
        />
      )}
      {dlg?.kind === 'delete' && (
        <ConfirmDialog
          open
          title={dlg.r.days ? t('task.deleteSeries') : t('task.deleteOnce')}
          confirmLabel={t('common.delete')}
          danger
          busy={w.busy}
          error={w.error}
          onConfirm={() =>
            void w.run(
              (rel) => deleteTask(dlg.r.id, dlg.r.rev, rel),
              () => {
                toast(t('task.deleted'));
                setDlg(null);
              },
            )
          }
          onClose={() => setDlg(null)}
        >
          <p style={{ margin: 0 }}>{t('task.deleteText')}</p>
        </ConfirmDialog>
      )}
      {w.dialog}
    </>
  );
}
