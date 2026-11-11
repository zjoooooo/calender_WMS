// Task create / edit (§6.8, R17). Tasks are standalone jobs for ONE customer and ONE non-routable waste
// type (OTC, COMPACTOR); they may fall on any day (Sunday and PH included) and never go inside a route.
// Create:
//   1. Type: chips of the active non-routable types.
//   2. Customer: search over all active customers; customers registered for the type first; others offer
//      [Add OTC to this customer] (PATCH the customer, then select it); "Create new customer" pre-ticks the type.
//   3. When: one-off date (default the clicked date or today), or recurring (only when the type allows it):
//      Mon–Sun chips, start and an optional end, with the hint that it runs on public holidays too.
//   4. Note.
// Edit: one-off -> note and date (Change date); recurring -> note, days, start, end (Edit series).
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTask, getTask, listCustomers, patchCustomer, patchTask, type CustomerListItem, type TaskPatch } from '../api';
import { fmtDay, useI18n, weekdayName, weekdayOf } from '../i18n';
import { useSession } from '../session';
import { Chip } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { Loading, useDebounced, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { CustomerFormDialog } from './CustomerFormDialog';
import { useGuardedWrite } from './officeShared';

type Props = { mode: 'create'; date?: string; onClose: () => void } | { mode: 'edit'; taskId: number; onClose: () => void };

type Picked = Pick<CustomerListItem, 'id' | 'code' | 'name' | 'address' | 'waste_types'>;

export function TaskDialog(props: Props) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const toast = useToast();
  const w = useGuardedWrite();
  const today = meta?.today ?? '';
  const types = (meta?.waste_types ?? []).filter((x) => !x.routable && x.active);
  const edit = props.mode === 'edit';
  const taskQ = useQuery({ queryKey: ['task', edit ? props.taskId : 0], queryFn: () => getTask((props as { taskId: number }).taskId), enabled: edit });
  const task = taskQ.data;

  const startDate = props.mode === 'create' && props.date && props.date >= today ? props.date : today;
  const [type, setType] = useState(types[0]?.code ?? '');
  const [customer, setCustomer] = useState<Picked | null>(null);
  const [kind, setKind] = useState<'once' | 'recurring'>('once');
  const [date, setDate] = useState(startDate);
  const [days, setDays] = useState<number[]>(startDate ? [weekdayOf(startDate)] : []);
  const [start, setStart] = useState(startDate);
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [loaded, setLoaded] = useState(!edit);

  useEffect(() => {
    if (!edit || !task || loaded) return;
    setType(task.waste_type);
    setKind(task.recurring || !task.date ? 'recurring' : 'once');
    setDate(task.date ?? '');
    setDays(task.days ?? []);
    setStart(task.start ?? '');
    setEnd(task.end ?? '');
    setNote(task.note);
    setLoaded(true);
  }, [edit, task, loaded]);

  const wt = (meta?.waste_types ?? []).find((x) => x.code === type);
  const canRecur = !!wt?.recurring_tasks;
  useEffect(() => {
    if (!edit && !canRecur && kind === 'recurring') setKind('once');
  }, [edit, canRecur, kind]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    w.setError(null);
    if (kind === 'recurring' && days.length === 0) return w.setError(t('rf.needDays'));
    if (props.mode === 'create') {
      if (!type) return w.setError(t('task.needType'));
      if (!customer) return w.setError(t('task.needCustomer'));
      const body =
        kind === 'once'
          ? { waste_type: type, customer_id: customer.id, date, note: note.trim() }
          : { waste_type: type, customer_id: customer.id, start, end: end || null, days: [...days].sort(), note: note.trim() };
      await w.run(
        () => createTask(body),
        () => {
          toast(t('task.created', { type: wt?.abbr || type, name: customer.name, when: kind === 'once' ? fmtDay(date, lang) : t('task.recurringShort') }));
          props.onClose();
        },
      );
      return;
    }
    if (!task) return;
    const body: TaskPatch = { rev: task.rev };
    if (note.trim() !== task.note) body.note = note.trim();
    if (kind === 'once') {
      if (date !== task.date) body.date = date;
    } else {
      if (JSON.stringify([...days].sort()) !== JSON.stringify(task.days ?? [])) body.days = [...days].sort();
      if (start !== (task.start ?? '')) body.start = start;
      if ((end || null) !== (task.end ?? null)) body.end = end || null;
    }
    await w.run(
      (rel) => patchTask(task.id, { ...body, ...(rel ? { release_run: true } : {}) }),
      () => {
        toast(t('common.saved'));
        props.onClose();
      },
    );
  };

  return (
    <>
      <Dialog
        open
        width={580}
        title={edit ? (kind === 'recurring' ? t('task.editSeries') : t('task.editOnce')) : t('task.newTitle')}
        onClose={props.onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="task-form" className="btn primary" disabled={w.busy || !loaded}>
              {edit ? t('common.save') : t('common.create')}
            </button>
          </>
        }
      >
        {edit && taskQ.isLoading && <Loading />}
        {loaded && (
          <form id="task-form" className="stack" onSubmit={submit} noValidate>
            <div className="field">
              <span>{t('task.type')}</span>
              <div className="chips" role="group" aria-label={t('task.type')}>
                {(edit ? (meta?.waste_types ?? []).filter((x) => x.code === type) : types).map((x) => (
                  <Chip key={x.code} pressed={type === x.code} disabled={edit} onClick={() => setType(x.code)} title={x.name}>
                    {x.abbr || x.code}
                  </Chip>
                ))}
              </div>
              {!edit && types.length === 0 && <span className="form-error">{t('task.noTypes')}</span>}
            </div>

            {edit ? (
              <div className="field">
                <span>{t('task.customer')}</span>
                <strong>{task?.customer?.name ?? `#${task?.customer_id}`}</strong>
                <span className="hint">{t('task.immutable')}</span>
              </div>
            ) : (
              <TaskCustomerPicker type={type} typeAbbr={wt?.abbr || type} value={customer} onChange={setCustomer} />
            )}

            <div className="field">
              <span>{t('task.when')}</span>
              {!edit && (
                <div className="seg" role="group" aria-label={t('task.when')}>
                  <button type="button" aria-pressed={kind === 'once'} onClick={() => setKind('once')}>
                    {t('task.once')}
                  </button>
                  <button type="button" aria-pressed={kind === 'recurring'} disabled={!canRecur} title={canRecur ? undefined : t('err.RECURRING_NOT_ALLOWED')} onClick={() => setKind('recurring')}>
                    ↻ {t('task.recurring')}
                  </button>
                </div>
              )}
            </div>
            {kind === 'once' ? (
              <label className="field">
                <span>{edit ? t('rf.changeDate') : t('common.date')}</span>
                <input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
                {date && <span className="hint">{fmtDay(date, lang)} · {t('task.anyDay')}</span>}
              </label>
            ) : (
              <>
                <div className="field">
                  <span>{t('rf.days')}</span>
                  <div className="chips" role="group" aria-label={t('rf.days')}>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <Chip key={d} pressed={days.includes(d)} onClick={() => setDays((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))}>
                        {weekdayName(d, lang)}
                      </Chip>
                    ))}
                  </div>
                  <span className="hint">{t('task.phHint')}</span>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>{t('rf.start')}</span>
                    <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>
                      {t('rf.end')} ({t('common.optional')})
                    </span>
                    <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
                  </label>
                </div>
              </>
            )}
            <label className="field">
              <span>{t('common.note')}</span>
              <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
            </label>
            {w.error && (
              <div className="form-error" role="alert">
                {w.error}
              </div>
            )}
          </form>
        )}
      </Dialog>
      {w.dialog}
    </>
  );
}

function TaskCustomerPicker({ type, typeAbbr, value, onChange }: { type: string; typeAbbr: string; value: Picked | null; onChange: (c: Picked | null) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const errText = useErrorText();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dq = useDebounced(q.trim(), 200);
  const res = useQuery({
    queryKey: ['customers', { q: dq, archived: '0', task: true }],
    queryFn: ({ signal }) => listCustomers({ q: dq, archived: '0' }, { signal }),
    enabled: dq.length > 0,
    staleTime: 30_000,
  });
  const list = useMemo(() => {
    const all = res.data ?? [];
    return [...all.filter((c) => c.waste_types.includes(type)), ...all.filter((c) => !c.waste_types.includes(type))].slice(0, 30);
  }, [res.data, type]);

  const addType = async (c: CustomerListItem) => {
    setBusyId(c.id);
    setError(null);
    try {
      const u = await patchCustomer(c.id, { waste_types: [...c.waste_types, type] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      onChange(u);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  if (value && value.waste_types.includes(type)) {
    return (
      <div className="field">
        <span>{t('task.customer')}</span>
        <div className="row">
          <strong>{value.name}</strong>
          <span className="muted small code">{value.code}</span>
          <span className="muted small">{value.address}</span>
          <button type="button" className="btn small" onClick={() => onChange(null)}>
            {t('task.changeCustomer')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="field">
      <span>{t('task.customer')}</span>
      <div className="picker">
        <input className="input" type="search" value={q} placeholder={t('picker.placeholder')} aria-label={t('task.customer')} onChange={(e) => setQ(e.target.value)} />
        {dq.length === 0 && <div className="muted small">{t('picker.hint')}</div>}
        {dq.length > 0 && (
          <div className="picker-list">
            {list.map((c) => {
              const has = c.waste_types.includes(type);
              return (
                <div key={c.id} className="picker-item" style={{ cursor: has ? 'pointer' : 'default' }} onClick={has ? () => onChange(c) : undefined}>
                  <span>
                    <strong>{c.name}</strong> <span className="muted code small">{c.code}</span>
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    {c.waste_types.map((x) => (
                      <span key={x} className="wtag">
                        {x}
                      </span>
                    ))}
                    {has ? (
                      <button type="button" className="btn small" onClick={() => onChange(c)}>
                        {t('task.select')}
                      </button>
                    ) : (
                      <button type="button" className="btn small" disabled={busyId === c.id} onClick={() => void addType(c)}>
                        {t('task.addTypeToCustomer', { type: typeAbbr })}
                      </button>
                    )}
                  </span>
                  {c.address && <span className="pa">{c.address}</span>}
                </div>
              );
            })}
            {res.isSuccess && list.length === 0 && <div className="muted small">{t('picker.none')}</div>}
          </div>
        )}
        <button type="button" className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setCreating(true)}>
          + {t('picker.create')}
        </button>
        {error && <div className="form-error">{error}</div>}
      </div>
      <CustomerFormDialog
        open={creating}
        customer={null}
        initialTypes={[type]}
        initialName={q.trim()}
        onClose={() => setCreating(false)}
        onSaved={(c) => {
          setCreating(false);
          onChange(c);
        }}
      />
    </div>
  );
}
