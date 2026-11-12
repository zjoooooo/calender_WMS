// Route customer picker (§6.1, R10): searches name, code and address over the active customers registered
// with the route's waste type (a route collects one type; customers without it never appear), hides
// customers already in the list, labels "also on N2 that day", and ends with "Create new customer" (the
// route's type pre-ticked and required).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCustomers, type Customer, type CustomerListItem } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { useDebounced, useErrorText } from '../ui/Feedback';
import { CustomerFormDialog } from './CustomerFormDialog';

export type PickedCustomer = Pick<Customer, 'id' | 'code' | 'name' | 'address' | 'waste_types' | 'active'>;

export function CustomerPicker(props: {
  /** The route's waste type: only customers registered with it are listed. */
  wasteType: string;
  excludeIds: number[];
  /** customer id -> codes of other routes on that date */
  alsoOn?: Map<number, string[]>;
  onPick: (c: PickedCustomer) => void;
  onClose?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const { meta } = useSession();
  const errText = useErrorText();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q.trim(), 200);
  const res = useQuery({
    queryKey: ['customers', { q: dq, type: props.wasteType, picker: true }],
    queryFn: ({ signal }) => listCustomers({ q: dq, type: props.wasteType, archived: '0' }, { signal }),
    enabled: dq.length > 0,
    staleTime: 30_000,
  });
  const routable = (meta?.waste_types ?? []).filter((w) => w.routable && w.active);
  const exclude = new Set(props.excludeIds);
  const list: CustomerListItem[] = (res.data ?? []).filter((c) => !exclude.has(c.id)).slice(0, 30);
  const tags = (c: { waste_types: string[] }) => c.waste_types.filter((code) => routable.some((w) => w.code === code));

  return (
    <div className="picker" role="group" aria-label={t('picker.title')}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          className="input"
          type="search"
          value={q}
          autoFocus={props.autoFocus}
          placeholder={t('picker.placeholder')}
          aria-label={t('picker.placeholder')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list.length > 0) {
              e.preventDefault();
              props.onPick(list[0]);
              setQ('');
            }
          }}
        />
        {props.onClose && (
          <button type="button" className="btn small" onClick={props.onClose}>
            {t('common.close')}
          </button>
        )}
      </div>
      {dq.length === 0 && <div className="muted small">{t('picker.hint')}</div>}
      {res.error ? <div className="form-error">{errText(res.error)}</div> : null}
      {dq.length > 0 && (
        <div className="picker-list">
          {list.map((c) => {
            const also = props.alsoOn?.get(c.id) ?? [];
            return (
              <button
                key={c.id}
                type="button"
                className="picker-item"
                onClick={() => {
                  props.onPick(c);
                  setQ('');
                }}
              >
                <span>
                  <strong>{c.name}</strong> <span className="muted code small">{c.code}</span>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  {tags(c).map((code) => (
                    <span key={code} className="wtag">
                      {routable.find((w) => w.code === code)?.abbr || code}
                    </span>
                  ))}
                  {also.length > 0 && <span className="tag warn">{t('picker.alsoOn', { codes: also.join(', ') })}</span>}
                </span>
                {c.address && <span className="pa">{c.address}</span>}
              </button>
            );
          })}
          {res.isSuccess && list.length === 0 && <div className="muted small">{t('picker.none')}</div>}
        </div>
      )}
      <button type="button" className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setCreating(true)}>
        + {t('picker.create')}
      </button>
      <CustomerFormDialog
        open={creating}
        customer={null}
        initialTypes={[props.wasteType]}
        requireType={props.wasteType}
        initialName={q.trim()}
        onClose={() => setCreating(false)}
        onSaved={(c) => {
          setCreating(false);
          setQ('');
          props.onPick(c);
        }}
      />
    </div>
  );
}
