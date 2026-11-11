// Task drawer (§6.8): type, customer (address, phone), schedule, note, status and driver, the result and
// the run actions (§6.12). Menu for a one-off: [Edit note / Change date] [Delete]; for a recurring date:
// [Skip this date] / [Restore] [Move this date…] [Edit series] [End series from date] [Delete series].
// Every write is rev-checked (R20) and subject to R26 on today (RunExistsDialog through useGuardedWrite).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deleteTask, getCustomer, patchTask, putTaskDate, resetTaskDate, type TaskOccurrence } from '../api';
import { fmtDay, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { ConfirmDialog } from '../ui/Dialog';
import { Drawer } from '../ui/Drawer';
import { useToast } from '../ui/Toast';
import { useCalendar } from './calendarContext';
import { addDays, jobOf } from './calendarModel';
import { EndDialog } from './CopyDialog';
import { taskScheduleText } from './labels';
import { MenuButton, runDetailText, useGuardedWrite, workDone, type MenuItem } from './officeShared';
import { ResultDialog } from './ResultDialog';
import { RunPanel } from './RunActions';
import { TaskDialog } from './TaskDialog';

export function TaskDrawer({ occ, onClose }: { occ: TaskOccurrence; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const { data, open } = useCalendar();
  const toast = useToast();
  const w = useGuardedWrite();
  const today = data.today;
  const past = occ.date < today;
  const cust = data.customers[String(occ.customer_id)];
  const custQ = useQuery({ queryKey: ['customer', occ.customer_id], queryFn: () => getCustomer(occ.customer_id) });
  const wt = meta?.waste_types.find((x) => x.code === occ.waste_type);
  const [dlg, setDlg] = useState<'edit' | 'end' | 'delete' | 'result' | null>(null);

  const schedule = taskScheduleText(
    occ.recurring ? { start: occ.start ?? null, end: occ.end ?? null, days: occ.days ?? [] } : { date: occ.date },
    t,
    lang,
  );
  const v = occ.visit;
  const canResult = occ.date <= today && (occ.status === 'scheduled' || !!occ.run);
  const blocked = occ.date === today && workDone(occ.run);
  const blockedTip = blocked ? t('rd.hasJob', { name: occ.run?.driver?.name ?? occ.run?.holders.slice(-1)[0] ?? '' }) : undefined;

  const setCancelled = (cancelled: boolean) =>
    w.run(
      (rel) => putTaskDate(occ.task_id, occ.date, { rev: occ.rev, cancelled, ...(rel ? { release_run: true } : {}) }),
      () => toast(cancelled ? t('rd.skipped', { date: fmtDay(occ.date, lang) }) : t('rd.restored')),
    );
  const items: (MenuItem | null)[] = [];
  if (!past && !occ.orphan) {
    if (occ.recurring) {
      if (occ.status === 'scheduled') items.push({ label: t('rd.skip'), onClick: () => void setCancelled(true), disabled: blocked, title: blockedTip });
      if (occ.status === 'cancelled') items.push({ label: t('rd.restore'), onClick: () => void setCancelled(false) });
      if (occ.edited) items.push({ label: t('rd.reset'), onClick: () => void w.run((rel) => resetTaskDate(occ.task_id, occ.date, occ.rev, rel), () => toast(t('rd.reset'))) });
      if (occ.status === 'scheduled') items.push({ label: t('copy.moveDate'), onClick: () => open({ kind: 'copy', occ, mode: 'move' }), disabled: blocked, title: blockedTip });
      items.push(null);
      items.push({ label: t('task.editSeries'), onClick: () => setDlg('edit') });
      items.push({ label: t('task.endSeries'), onClick: () => setDlg('end'), disabled: blocked, title: blockedTip });
      items.push({ label: t('task.deleteSeries'), onClick: () => setDlg('delete'), danger: true, disabled: blocked, title: blockedTip });
    } else {
      items.push({ label: t('task.editOnce'), onClick: () => setDlg('edit'), disabled: blocked, title: blockedTip });
      items.push({ label: t('copy.title') + '…', onClick: () => open({ kind: 'copy', occ, mode: 'copy' }) });
      items.push(null);
      items.push({ label: t('common.delete'), onClick: () => setDlg('delete'), danger: true, disabled: blocked, title: blockedTip });
    }
  } else if (!occ.orphan) {
    items.push({ label: t('copy.title') + '…', onClick: () => open({ kind: 'copy', occ, mode: 'copy' }) });
  }

  let statusLine: string;
  const covered = occ.covered_by.map((c) => fmtDay(c.date, lang)).join(', ');
  if (occ.status === 'cancelled') statusLine = covered ? t('task.movedTo', { date: covered }) : t('rd.cancelled');
  else if (occ.date > today) statusLine = t('status.planned');
  else statusLine = runDetailText(occ.run_status, occ.run, t, meta?.waste_types, meta?.now) || t('status.planned');

  const remove = () =>
    w.run(
      (rel) => deleteTask(occ.task_id, occ.rev, rel),
      () => {
        toast(t('task.deleted'));
        setDlg(null);
        onClose();
      },
    );
  const endFrom = (from: string) =>
    w.run(
      (rel) => patchTask(occ.task_id, { rev: occ.rev, end: addDays(from, -1), ...(rel ? { release_run: true } : {}) }),
      () => {
        toast(t('rd.ended', { date: fmtDay(from, lang) }));
        setDlg(null);
      },
    );

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        label={`${occ.waste_type} ${cust?.name ?? ''}`}
        title={
          <div className="rd-title">
            <span className="wtag" style={{ fontSize: 13 }}>
              {wt?.abbr || occ.waste_type}
            </span>
            {occ.recurring && <span title={t('task.recurring')}>↻</span>}
            <strong>{cust?.name ?? `#${occ.customer_id}`}</strong>
            {occ.edited && <span className="tag warn">{t('cal.edited')}</span>}
          </div>
        }
        header={
          <>
            <div className="rd-rule">
              {fmtDay(occ.date, lang)} · {schedule}
            </div>
            <div className="status-box" role="status">
              {past ? `🔒 ${t('rd.pastNote')} ` : ''}
              {statusLine}
            </div>
          </>
        }
        footer={
          <>
            {w.error && (
              <div className="form-error" role="alert">
                {w.error}
              </div>
            )}
            <div className="acts">
              <RunPanel occ={occ} today={today} customerName={cust?.name} onReplan={past ? () => open({ kind: 'copy', occ, mode: 'copy' }) : undefined} />
              <span className="spacer" />
              {items.length > 0 && <MenuButton label={`${t('common.menu')} ▾`} items={items} up />}
              <button type="button" className="btn" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        }
      >
        <dl className="stack" style={{ gap: 6, margin: 0 }}>
          <div>
            <dt className="muted small">{t('task.customer')}</dt>
            <dd style={{ margin: 0 }}>
              <strong>{cust?.name}</strong> <span className="code small muted">{cust?.code}</span>
              <div className="small">{cust?.address}</div>
              {custQ.data?.phone && <div className="small">☎ {custQ.data.phone}</div>}
              {custQ.data?.note && <div className="small muted">{custQ.data.note}</div>}
            </dd>
          </div>
          {occ.note && (
            <div>
              <dt className="muted small">{t('common.note')}</dt>
              <dd style={{ margin: 0 }}>{occ.note}</dd>
            </div>
          )}
          {occ.copied_from && (
            <div className="muted small">{t('task.copiedFrom', { date: fmtDay(occ.copied_from.date, lang) })}</div>
          )}
          <div>
            <dt className="muted small">{t('task.result')}</dt>
            <dd style={{ margin: 0 }}>
              {v?.outcome === 'collected' ? (
                <span className="vis-ok">
                  ✓{' '}
                  {Object.entries(v.weights)
                    .map(([k, x]) => `${k} ${fmtWeight(Number(x))} ${wt?.unit ?? 'kg'}`)
                    .join(' · ')}
                  {Object.values(v.tickets ?? {}).length ? ` · #${Object.values(v.tickets).join(', ')}` : ''}
                  {v.driver ? ` · ${v.driver}` : ''} {v.photos ? `· 📷${v.photos}` : ''} {v.signature ? '· ✍' : ''}
                </span>
              ) : v?.outcome === 'missed' ? (
                <span className="vis-miss">✗ {v.reason ? t(`reason.${v.reason}`) : t('status.notCollected')}</span>
              ) : (
                <span className="muted">–</span>
              )}
              {v?.note && <div className="small muted">{v.note}</div>}
              {v?.flags.map((f) => (
                <span key={f} className="flag" style={{ marginLeft: 4 }}>
                  {f}
                </span>
              ))}
            </dd>
          </div>
          {canResult && (
            <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setDlg('result')}>
              {v?.outcome ? t('task.correctResult') : t('task.enterResult')}
            </button>
          )}
        </dl>
      </Drawer>
      {dlg === 'edit' && <TaskDialog mode="edit" taskId={occ.task_id} onClose={() => setDlg(null)} />}
      {dlg === 'end' && (
        <EndDialog title={t('task.endSeries')} initial={occ.date} min={today} busy={w.busy} error={w.error} onSubmit={(d) => void endFrom(d)} onClose={() => setDlg(null)} />
      )}
      <ConfirmDialog
        open={dlg === 'delete'}
        title={occ.recurring ? t('task.deleteSeries') : t('task.deleteOnce')}
        confirmLabel={t('common.delete')}
        danger
        busy={w.busy}
        error={w.error}
        onConfirm={() => void remove()}
        onClose={() => setDlg(null)}
      >
        <p style={{ margin: 0 }}>{t('task.deleteText')}</p>
      </ConfirmDialog>
      {dlg === 'result' && (
        <ResultDialog
          target={{
            date: occ.date,
            job: jobOf(occ),
            customerId: occ.customer_id,
            customerName: cust?.name ?? `#${occ.customer_id}`,
            weighTypes: [occ.waste_type],
            defaultDriverId: occ.run?.driver?.id ?? null,
          }}
          onClose={() => setDlg(null)}
        />
      )}
      {w.dialog}
    </>
  );
}
