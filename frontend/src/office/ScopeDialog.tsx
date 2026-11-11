// Scope dialog for a recurring route's container edit (§6.2, R12):
// (•) Only <D>: writes override(D).stops and note. Pre-selected, except for a route that has no customer
//     list yet (D inherits an empty list, e.g. just created): then "<D> and all following" is pre-selected,
//     so the first customers become the route's list for every date it runs.
// ( ) <D> and all following: a template replace (when D is the next date the route runs) or a split from D
//     (R14, same code, so the calendar looks the same). Dates that already have their own list are listed
//     as "Not changed". For today's container with a run it adds the driver impact, computed client-side.
// Round 6: a later part of a split route keeps its own list; only the clerk's change reaches it (routeCarry).
// Each later part whose customers after the save differ from the list being saved is named, with the
// customers it also has and the ones it does not have (an order of its own is not named).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRoute, listCustomers, type RouteOccurrence, type Stop } from '../api';
import { fmtDay, useI18n } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { keptListsFollowing, keptListText } from './routeCarry';

export type Scope = 'this' | 'following';

/** "following" for a date that inherits an empty list (a new route), otherwise "this" (§6.2). */
export function defaultScope(occ: Pick<RouteOccurrence, 'stops' | 'edited'>): Scope {
  return occ.stops.length === 0 && !occ.edited ? 'following' : 'this';
}

export function ScopeDialog(props: {
  occ: RouteOccurrence;
  today: string;
  /** The list being saved, and the names the drawer knows (customers picked or created in it). */
  stops: Stop[];
  nameOf: (id: number) => string | undefined;
  added: number;
  removed: number;
  busy?: boolean;
  error?: string | null;
  onSave: (scope: Scope) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const { occ } = props;
  const [scope, setScope] = useState<Scope>(() => defaultScope(occ));
  const routeQ = useQuery({ queryKey: ['route', occ.route_id], queryFn: () => getRoute(occ.route_id) });
  const own = (routeQ.data?.overrides ?? []).filter((o) => o.date > occ.date && o.stops !== null && !o.cancelled).map((o) => fmtDay(o.date, lang));
  const kept = useMemo(() => keptListsFollowing(routeQ.data?.parts ?? [], occ.route_id, props.stops), [routeQ.data, occ.route_id, props.stops]);
  // A later part's customers may not be in the calendar's payload: their names come from the customer list,
  // and the notices wait for it rather than show "#145".
  const custQ = useQuery({ queryKey: ['customers', { archived: 'all' }], queryFn: () => listCustomers({ archived: 'all' }), staleTime: 60_000, enabled: kept.length > 0 });
  const nameOf = (id: number) => props.nameOf(id) ?? custQ.data?.find((c) => c.id === id)?.name ?? `#${id}`;
  const named = !custQ.isPending || kept.every((k) => [...k.also, ...k.lacks].every((id) => props.nameOf(id) !== undefined));
  const d = fmtDay(occ.date, lang);
  const run = occ.run;
  const impact: string[] = [];
  if (occ.date === props.today && run) {
    const who = run.driver?.name ?? t('status.open');
    const head = `${occ.code} (${who}, ${run.collected + run.missed}/${run.total})`;
    if (props.added) impact.push(t('scope.impactAdd', { what: head, n: props.added }));
    if (props.removed) impact.push(t('scope.impactRemove', { what: head, n: props.removed }));
  }
  return (
    <Dialog
      open
      title={t('scope.title')}
      onClose={props.onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={props.busy} onClick={() => props.onSave(scope)} data-autofocus>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="scope" role="radiogroup" aria-label={t('scope.title')}>
        <label>
          <input type="radio" name="scope" checked={scope === 'this'} onChange={() => setScope('this')} />
          <span>{t('scope.this', { date: d })}</span>
        </label>
        <label>
          <input type="radio" name="scope" checked={scope === 'following'} onChange={() => setScope('following')} />
          <span>
            {t('scope.following', { date: d })}
            <br />
            <span className="muted small">{t('scope.followingHint')}</span>
          </span>
        </label>
      </div>
      {own.length > 0 && <div className="note">{t('scope.notChanged', { dates: own.join(', ') })}</div>}
      {named &&
        kept.map((k) => (
          <div key={k.part.id} className="banner info" data-testid="kept-list">
            {keptListText(k, props.today, t, lang, nameOf)}
          </div>
        ))}
      {impact.map((s) => (
        <div key={s} className="banner info">
          {s}
        </div>
      ))}
      {props.error && (
        <div className="form-error" role="alert">
          {props.error}
        </div>
      )}
    </Dialog>
  );
}
