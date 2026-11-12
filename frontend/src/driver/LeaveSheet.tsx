// S5 Leave sheet (§9.3, R24) and the Switch sheet (§7.5).
// Leave: "5 stops not done" -> [Give back] (the route becomes Needs driver) | [Mark all not collected…]
// (asks a reason; the route becomes done) | [Cancel].
// Switch: "Leave W2? 3 stops done, 5 left. The 5 go back to Needs driver; your 3 stay recorded under your
// name." -> [Switch to ⚡A2] | [Cancel, keep W2]. Warns first when a stop form of W2 has unsaved values.
import { useState } from 'react';
import type { MissReason } from '../api';
import { useI18n } from '../i18n';
import { Sheet } from './parts';

export const DRIVER_REASONS: Exclude<MissReason, 'not_visited'>[] = ['no_waste', 'closed', 'no_access', 'refused', 'other'];

/** Reason buttons + note; "other" needs a note (R27 REASON_REQUIRED). */
export function ReasonPicker(props: { reason: MissReason | null; note: string; onReason: (r: MissReason) => void; onNote: (n: string) => void; noteError?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <div className="reasons" role="group" aria-label={t('driver.reason.label')}>
        {DRIVER_REASONS.map((r) => (
          <button key={r} type="button" className="dbtn" aria-pressed={props.reason === r} onClick={() => props.onReason(r)}>
            {t('driver.reason.' + r)}
          </button>
        ))}
      </div>
      <label className={props.noteError ? 'dfield invalid' : 'dfield'}>
        <span>
          {t('common.note')}
          {props.reason === 'other' ? '' : ` (${t('common.optional')})`}
        </span>
        <textarea name="reason-note" maxLength={500} value={props.note} onChange={(e) => props.onNote(e.target.value)} />
        {props.noteError && <span className="err">{t('err.REASON_REQUIRED')}</span>}
      </label>
    </>
  );
}

export function LeaveSheet(props: {
  open: boolean;
  pending: number;
  busy: boolean;
  error: string | null;
  onGiveBack: () => void;
  onMarkAll: (reason: MissReason, note: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<'choose' | 'reason'>('choose');
  const [reason, setReason] = useState<MissReason | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState(false);
  const close = () => {
    setStep('choose');
    setReason(null);
    setNote('');
    setNoteErr(false);
    props.onClose();
  };
  return (
    <Sheet open={props.open} title={t('driver.leave.title', { n: props.pending })} onClose={close} busy={props.busy} testId="leave-sheet">
      {step === 'choose' ? (
        <>
          <button type="button" className="dbtn primary" disabled={props.busy} onClick={props.onGiveBack}>
            {t('driver.leave.giveBack')}
          </button>
          <button type="button" className="dbtn" disabled={props.busy} onClick={() => setStep('reason')}>
            {t('driver.leave.markAll')}
          </button>
        </>
      ) : (
        <>
          <div>{t('driver.leave.reasonFor', { n: props.pending })}</div>
          <ReasonPicker reason={reason} note={note} onReason={setReason} onNote={setNote} noteError={noteErr} />
          <button
            type="button"
            className="dbtn primary"
            disabled={props.busy || !reason}
            onClick={() => {
              if (reason === 'other' && !note.trim()) return setNoteErr(true);
              if (reason) props.onMarkAll(reason, note.trim());
            }}
          >
            {t('driver.leave.markAllConfirm', { n: props.pending })}
          </button>
        </>
      )}
      {props.error && (
        <div className="form-err" role="alert">
          {props.error}
        </div>
      )}
      <button type="button" className="dbtn" disabled={props.busy} onClick={close}>
        {t('common.cancel')}
      </button>
    </Sheet>
  );
}

export function SwitchSheet(props: {
  open: boolean;
  from: { code: string; pending: number; total: number };
  toLabel: string;
  drafts: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const done = Math.max(0, props.from.total - props.from.pending);
  return (
    <Sheet open={props.open} title={t('driver.switch.title', { code: props.from.code })} onClose={props.onClose} busy={props.busy} testId="switch-sheet">
      <div>{t('driver.switch.body', { done, left: props.from.pending })}</div>
      {props.drafts > 0 && (
        <div className="dban warn" role="alert">
          {t('driver.switch.drafts', { n: props.drafts })}
        </div>
      )}
      {props.error && (
        <div className="form-err" role="alert">
          {props.error}
        </div>
      )}
      <button type="button" className="dbtn primary big" disabled={props.busy} onClick={props.onConfirm}>
        {t('driver.switch.confirm', { to: props.toLabel })}
      </button>
      <button type="button" className="dbtn" disabled={props.busy} onClick={props.onClose}>
        {t('driver.switch.cancel', { code: props.from.code })}
      </button>
    </Sheet>
  );
}
