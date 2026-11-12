// S6 Route done (§9.3): collected, missed and the totals per type, then [Back to Today].
import { Link, useParams } from 'react-router-dom';
import { useI18n } from '../i18n';
import { ErrorBanner, Loading } from '../ui/Feedback';
import { useDriver } from './driverContext';
import { localEntries, mergedProgress, typeMap, useJob, useToday } from './data';
import { BottomBar, RouteHead, TopBar } from './parts';
import { totalsText } from './Run';

export default function Done() {
  const { date = '', job = '' } = useParams();
  const { t } = useI18n();
  const { me, entries } = useDriver();
  const q = useJob(date, job);
  const today = useToday();
  const types = typeMap(today.data?.data.waste_types);
  const j = q.data?.data;
  const prog = j ? mergedProgress(j, localEntries(entries, date, job), me.id) : null;
  return (
    <div className="drv has-bar">
      <TopBar back="/driver" title={t('driver.done.title')} at={q.data?.at} cached={q.data?.cached} />
      <main className="drv-main" data-testid="route-done">
        {!j ? (
          q.error ? <ErrorBanner error={q.error} /> : <Loading />
        ) : (
          <>
            <RouteHead code={j.code} color={j.color} type={j.type} name={j.name}>
              <div className="prog">✓ {t('driver.done.title')}</div>
            </RouteHead>
            <div className="dban ok">{t('driver.done.counts', { collected: prog!.collected, missed: prog!.missed, total: prog!.total })}</div>
            {Object.keys(prog!.totals).length > 0 && <div className="totals">{totalsText(prog!.totals, types)}</div>}
            {prog!.pending > 0 && <div className="dban warn">{t('driver.done.stillPending', { n: prog!.pending })}</div>}
          </>
        )}
      </main>
      <BottomBar>
        <Link className="dbtn primary big" to="/driver">
          {t('driver.backToToday')}
        </Link>
      </BottomBar>
    </div>
  );
}
