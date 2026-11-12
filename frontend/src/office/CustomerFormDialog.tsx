// Create / edit customer (R4, §6.9). Reusable: the route picker's "Create new customer" passes
// initialTypes=[the route's waste type] and requireType (the new customer must have that type).
// - waste_types: at least one; active types are chips; an inactive type already on the customer shows
//   as a greyed chip that can still be removed.
// - Removing a type while the customer is on a route of that type -> 409 CUSTOMER_IN_USE: the dialog lists
//   the routes and offers [Remove from these routes and save] (detach: true). RUN_EXISTS -> RunExistsDialog.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createCustomer,
  isApiError,
  listWasteTypes,
  patchCustomer,
  type Customer,
  type CustomerInUseDetails,
  type CustomerWrite,
} from '../api';
import { useI18n } from '../i18n';
import { Chip } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { removedItemText, routableNames } from './labels';
import { RunExistsDialog } from './RunExistsDialog';

export interface CustomerFormDialogProps {
  open: boolean;
  /** null = create. */
  customer: Customer | null;
  /** Pre-ticked types for a new customer. */
  initialTypes?: string[];
  /** The waste type the new customer must have (route picker quick-create: the route's type). */
  requireType?: string;
  /** Pre-filled name for a new customer (e.g. the search text). */
  initialName?: string;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}

type Extra = { detach?: boolean; release_run?: boolean };

export function CustomerFormDialog(props: CustomerFormDialogProps) {
  const { open, customer } = props;
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const typesQ = useQuery({ queryKey: ['waste-types'], queryFn: listWasteTypes, enabled: open });
  const types = typesQ.data ?? [];

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inUse, setInUse] = useState<CustomerInUseDetails | null>(null);
  const [runErr, setRunErr] = useState<{ error: ApiError; extra: Extra } | null>(null);

  // Reset the form each time it opens.
  useEffect(() => {
    if (!open) return;
    setCode(customer?.code ?? '');
    setName(customer?.name ?? props.initialName ?? '');
    setAddress(customer?.address ?? '');
    setPhone(customer?.phone ?? '');
    setNote(customer?.note ?? '');
    setPicked(customer ? [...customer.waste_types] : [...(props.initialTypes ?? [])]);
    setError(null);
    setInUse(null);
    setRunErr(null);
    setBusy(false);
  }, [open, customer?.id]);

  // Chips: active types, plus inactive ones the customer already has (greyed, removable).
  const original = customer?.waste_types ?? [];
  const chipTypes = useMemo(() => types.filter((w) => w.active || original.includes(w.code)), [types, original]);

  const toggle = (code: string) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]));

  const save = async (extra: Extra = {}) => {
    if (!name.trim()) return setError(t('err.required_field', { field: t('customers.fieldName') }));
    if (picked.length === 0) return setError(t('customers.needType'));
    if (props.requireType && !picked.includes(props.requireType)) {
      const w = types.find((x) => x.code === props.requireType);
      return setError(t('customers.needRoutable', { routable: w?.abbr || props.requireType }));
    }
    // Store in waste-type order (the server does the same, R4).
    const ordered = types.map((w) => w.code).filter((c) => picked.includes(c));
    const body: CustomerWrite = {
      name: name.trim(),
      address: address.trim(),
      phone: phone.trim(),
      note: note.trim(),
      waste_types: ordered.length ? ordered : picked,
    };
    if (code.trim()) body.code = code.trim().toUpperCase();
    setBusy(true);
    setError(null);
    try {
      let saved: Customer;
      if (customer) {
        const r = await patchCustomer(customer.id, { ...body, ...extra });
        if (r.removed && r.removed.length) toast(t('customers.detached', { n: r.removed.length }));
        else toast(t('common.saved'));
        saved = r;
      } else {
        saved = await createCustomer(body as CustomerWrite & { name: string; waste_types: string[] });
        toast(t('customers.created', { name: saved.name }));
      }
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      setInUse(null);
      setRunErr(null);
      props.onSaved(saved);
    } catch (e) {
      if (isApiError(e, 'CUSTOMER_IN_USE')) setInUse(e.details as CustomerInUseDetails);
      else if (isApiError(e, 'RUN_EXISTS')) setRunErr({ error: e, extra });
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const inUseItems = inUse?.routes ?? [];

  return (
    <>
      <Dialog
        open={open}
        title={customer ? t('customers.edit') : t('customers.new')}
        onClose={props.onClose}
        width={560}
        footer={
          inUse ? (
            <>
              <button type="button" className="btn" onClick={() => setInUse(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => save({ detach: true })}>
                {t('customers.inUseDetach')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={props.onClose}>
                {t('common.cancel')}
              </button>
              <button type="submit" form="customer-form" className="btn primary" disabled={busy}>
                {t('common.save')}
              </button>
            </>
          )
        }
      >
        {inUse ? (
          <div className="stack">
            <div className="banner warn">
              <strong>{t('customers.inUseTitle')}</strong>
              <div>{t('customers.inUseText')}</div>
            </div>
            <ul className="list-plain">
              {inUseItems.map((it, i) => (
                <li key={i}>{removedItemText(it, t, lang)}</li>
              ))}
            </ul>
            {error && <div className="form-error" role="alert">{error}</div>}
          </div>
        ) : (
          <form id="customer-form" className="form-grid" onSubmit={submit} noValidate>
            <label className="field">
              <span>{t('customers.fieldName')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required data-autofocus />
            </label>
            <label className="field">
              <span>{t('customers.fieldCode')}</span>
              <input
                className="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={20}
                placeholder="C0001"
                spellCheck={false}
              />
            </label>
            <label className="field full">
              <span>{t('customers.fieldAddress')}</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
            </label>
            <label className="field">
              <span>{t('customers.fieldPhone')}</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />
            </label>
            <label className="field">
              <span>{t('customers.fieldNote')}</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </label>
            <div className="field full">
              <span>{t('customers.fieldTypes')}</span>
              <div className="chips" role="group" aria-label={t('customers.fieldTypes')}>
                {chipTypes.map((w) => (
                  <Chip key={w.code} pressed={picked.includes(w.code)} onClick={() => toggle(w.code)} inactive={!w.active} title={w.name}>
                    {w.active ? w.abbr || w.code : t('customers.typeInactive', { code: w.abbr || w.code })}
                  </Chip>
                ))}
              </div>
              <span className="hint">{t('customers.typesHint', { routable: routableNames(types) })}</span>
            </div>
            {customer && <div className="full note">{t('customers.everywhere')}</div>}
            {error && (
              <div className="full form-error" role="alert">
                {error}
              </div>
            )}
          </form>
        )}
      </Dialog>
      <RunExistsDialog
        error={runErr?.error ?? null}
        busy={busy}
        onClose={() => setRunErr(null)}
        onRelease={() => {
          const extra = { ...(runErr?.extra ?? {}), release_run: true };
          setRunErr(null);
          void save(extra);
        }}
      />
    </>
  );
}
