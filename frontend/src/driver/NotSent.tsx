// S7 Not sent (§7.7, §9.3): results the server refused (NOT_HOLDER, EDIT_WINDOW_CLOSED, NOT_ON_JOB, …),
// with the server's reason and the values, so the driver can show them to the office. Each one can be
// opened, edited and resent, resent as is, or removed once the office has it.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { useI18n } from '../i18n';
import { useErrorText } from '../ui/Feedback';
import { useDriver } from './driverContext';
import type { NotSentEntry } from './outbox';
import { BottomBar, Sheet, TopBar } from './parts';

export default function NotSent() {
  const { t, day } = useI18n();
  const errText = useErrorText();
  const { notsent, box, refresh, flushNow, online } = useDriver();
  const [remove, setRemove] = useState<NotSentEntry | null>(null);

  const reasonText = (e: NotSentEntry) => errText(new ApiError(e.error.code, e.error.http, e.error.message, e.error.field, e.error.details));
  const values = (e: NotSentEntry) => {
    const b = e.body;
    if (b.outcome === 'collected') {
      return Object.entries(b.weights ?? {})
        .map(([c, w]) => `${c} ${w} kg`)
        .concat(Object.entries(b.tickets ?? {}).map(([c, x]) => `${t('driver.form.ticket', { type: c })}: ${x}`))
        .join(' · ');
    }
    if (b.outcome === 'missed') return '✗ ' + t('driver.reason.' + (b.reason ?? 'other'));
    return t('driver.form.undo');
  };

  return (
    <div className="drv has-bar">
      <TopBar back="/driver" title={t('driver.notsent.title')} />
      <main className="drv-main" data-testid="notsent">
        {notsent.length === 0 ? (
          <div className="empty">{t('driver.notsent.none')}</div>
        ) : (
          <div className="dban warn">{t('driver.notsent.hint')}</div>
        )}
        {notsent.map((e) => (
          <div key={e.id} className="nscard">
            <div>
              <b>{e.label.customer}</b> · <span className="code">{e.label.job_label}</span> · {day(e.date)}
            </div>
            <div className="why">{reasonText(e)}</div>
            <div>{values(e)}</div>
            {e.body.note ? <div className="meta">{e.body.note}</div> : null}
            {(e.body.photos?.length || e.body.signature) && (
              <div className="meta">
                {t('driver.notsent.files', { photos: e.body.photos?.length ?? 0, sig: e.body.signature ? 1 : 0 })}
              </div>
            )}
            <div className="dbtns">
              <Link className="dbtn" to={`/driver/job/${e.date}/${e.job}/stop/${e.customer_id}?notsent=${e.id}`}>
                {t('driver.notsent.edit')}
              </Link>
              <button
                type="button"
                className="dbtn"
                disabled={!online}
                onClick={async () => {
                  await box.resend(e.id);
                  await refresh();
                  void flushNow();
                }}
              >
                {t('driver.notsent.resend')}
              </button>
            </div>
            <button type="button" className="dbtn danger" onClick={() => setRemove(e)}>
              {t('driver.notsent.remove')}
            </button>
          </div>
        ))}
      </main>
      <BottomBar>
        <Link className="dbtn primary big" to="/driver">
          {t('driver.backToToday')}
        </Link>
      </BottomBar>
      <Sheet open={!!remove} title={t('driver.notsent.removeTitle')} onClose={() => setRemove(null)}>
        <div>{t('driver.notsent.removeBody', { customer: remove?.label.customer ?? '' })}</div>
        <button
          type="button"
          className="dbtn danger"
          onClick={async () => {
            if (remove) await box.discardNotSent(remove.id);
            setRemove(null);
            await refresh();
          }}
        >
          {t('driver.notsent.removeYes')}
        </button>
        <button type="button" className="dbtn" onClick={() => setRemove(null)}>
          {t('common.cancel')}
        </button>
      </Sheet>
    </div>
  );
}
