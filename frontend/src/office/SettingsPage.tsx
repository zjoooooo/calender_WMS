// Settings page (§9.2):
// - Waste types (admin; read-only for office): code, name, abbr, unit, weigh method, routable (read-only
//   after create), recurring tasks, confirm-over, active, and the display order (dnd-kit sortable + ↑ ↓).
//   No delete. Deactivation can return 409 WASTE_TYPE_IN_USE {routes | tasks}.
// - Trucks (office and admin): the plates drivers pick from, each with an active toggle.
// - Day rollover (admin; read-only for office): 00:00–06:00; ROLLOVER_SHIFTS_TODAY "Try again after …".
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  createWasteType,
  getSettings,
  isApiError,
  listTrucks,
  listWasteTypes,
  orderWasteTypes,
  patchSettings,
  patchWasteType,
  putTrucks,
  type Truck,
  type WasteType,
  type WasteTypeInUseDetails,
  type WeighMethod,
} from '../api';
import { fmtHour, useI18n } from '../i18n';
import { useSession } from '../session';
import { WasteTag } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { taskScheduleText } from './labels';

export default function SettingsPage() {
  const { t } = useI18n();
  return (
    <>
      <div className="page-head">
        <h1>{t('settings.title')}</h1>
      </div>
      <RolloverSection />
      <TrucksSection />
      <WasteTypesSection />
    </>
  );
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="section-head">
        <h2 style={{ margin: 0 }}>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

// ---- day rollover -------------------------------------------------------------------------------

function RolloverSection() {
  const { t } = useI18n();
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const [hour, setHour] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setHour(q.data.rollover_hour);
  }, [q.data]);

  const save = async () => {
    if (hour === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await patchSettings({ rollover_hour: hour });
      qc.setQueryData(['settings'], r);
      void qc.invalidateQueries({ queryKey: ['meta'] });
      toast(t('rollover.saved', { time: fmtHour(r.rollover_hour) }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('rollover.title')}>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {q.data && (
        <div className="stack">
          <div className="row">
            {isAdmin ? (
              <>
                <label className="field" style={{ width: 200 }}>
                  <span>{t('rollover.label')}</span>
                  <select value={hour ?? q.data.rollover_hour} onChange={(e) => setHour(Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5, 6].map((h) => (
                      <option key={h} value={h}>
                        {fmtHour(h)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy || hour === q.data.rollover_hour} onClick={save}>
                  {t('common.save')}
                </button>
              </>
            ) : (
              <>
                <strong className="num">{t('rollover.current', { time: fmtHour(q.data.rollover_hour) })}</strong>
                <span className="muted small">{t('settings.adminOnly')}</span>
              </>
            )}
          </div>
          <div className="muted small" style={{ maxWidth: 760 }}>{t('rollover.hint')}</div>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}
    </Section>
  );
}

// ---- trucks -------------------------------------------------------------------------------------

const normalizePlate = (s: string) => s.replace(/\s+/g, '').toUpperCase();

function TrucksSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['trucks'], queryFn: listTrucks });
  const [draft, setDraft] = useState<Truck[] | null>(null);
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = draft ?? q.data ?? [];
  const dirty = draft !== null;

  const edit = (next: Truck[]) => setDraft(next);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const p = normalizePlate(plate);
    if (!p) return;
    if (!/^[A-Z0-9-]{1,15}$/.test(p)) return setError(t('trucks.invalid'));
    if (list.some((x) => x.plate === p)) return setError(t('trucks.duplicate', { plate: p }));
    setError(null);
    edit([...list, { plate: p, active: true }]);
    setPlate('');
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await putTrucks(list);
      qc.setQueryData(['trucks'], r);
      void qc.invalidateQueries({ queryKey: ['meta'] });
      setDraft(null);
      toast(t('trucks.saved'));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('trucks.title')} extra={<span className="muted small">{t('trucks.hint')}</span>}>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {q.data && (
        <div className="stack">
          {list.length === 0 && <div className="muted small">{t('trucks.empty')}</div>}
          {list.length > 0 && (
            <div className="chips">
              {list.map((tr, i) => (
                <span key={tr.plate} className="chip" style={tr.active ? undefined : { opacity: 0.6 }}>
                  <span className="code">{tr.plate}</span>
                  <label className="check small">
                    <input
                      type="checkbox"
                      checked={tr.active}
                      onChange={(e) => edit(list.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))}
                    />
                    {t('common.active')}
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    aria-label={`${t('trucks.remove')} ${tr.plate}`}
                    onClick={() => edit(list.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="row" onSubmit={add}>
            <input
              className="input code"
              style={{ width: 200 }}
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder={t('trucks.placeholder')}
              aria-label={t('trucks.plate')}
              maxLength={20}
            />
            <button type="submit" className="btn" disabled={!plate.trim()}>
              + {t('trucks.add')}
            </button>
            <span className="spacer" />
            {dirty && <span className="tag warn">{t('common.unsaved')}</span>}
            {dirty && (
              <button type="button" className="btn" onClick={() => { setDraft(null); setError(null); }}>
                {t('common.discard')}
              </button>
            )}
            <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
              {t('common.save')}
            </button>
          </form>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}
    </Section>
  );
}

// ---- waste types --------------------------------------------------------------------------------

function WasteTypesSection() {
  const { t } = useI18n();
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['waste-types'], queryFn: listWasteTypes });
  const [order, setOrder] = useState<string[] | null>(null); // draft order (codes)
  const [editing, setEditing] = useState<WasteType | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sensors exactly as §11.1: mouse after 5 px, touch after a 200 ms hold, keyboard.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byCode: Record<string, WasteType> = {};
  for (const w of q.data ?? []) byCode[w.code] = w;
  const codes = order ?? (q.data ?? []).map((w) => w.code);
  const rows = codes.map((c) => byCode[c]).filter(Boolean);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= codes.length || from === to) return;
    setOrder(arrayMove(codes, from, to));
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(codes.indexOf(String(e.active.id)), codes.indexOf(String(e.over.id)));
  };
  const saveOrder = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await orderWasteTypes(codes);
      qc.setQueryData(['waste-types'], r);
      void qc.invalidateQueries({ queryKey: ['meta'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      setOrder(null);
      toast(t('wt.orderSaved'));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t('wt.title')}
      extra={
        <>
          {!isAdmin && <span className="muted small">{t('settings.adminOnly')}</span>}
          {isAdmin && <span className="muted small">{t('wt.orderHint')}</span>}
          <span className="spacer" />
          {isAdmin && order && (
            <>
              <span className="tag warn">{t('common.unsaved')}</span>
              <button type="button" className="btn" onClick={() => setOrder(null)}>
                {t('common.discard')}
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={saveOrder}>
                {t('wt.orderSave')}
              </button>
            </>
          )}
          {isAdmin && !order && (
            <button type="button" className="btn primary" onClick={() => setEditing('new')}>
              + {t('wt.add')}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {error && <div className="form-error" role="alert">{error}</div>}
      {q.data && (
        <div className="table-wrap">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <table className="table">
              <thead>
                <tr>
                  {isAdmin && <th aria-label={t('common.dragHandle')} />}
                  <th>{t('wt.colCode')}</th>
                  <th>{t('wt.colName')}</th>
                  <th>{t('wt.colAbbr')}</th>
                  <th>{t('wt.colUnit')}</th>
                  <th>{t('wt.colWeigh')}</th>
                  <th>{t('wt.colRoutable')}</th>
                  <th>{t('wt.colRecurring')}</th>
                  <th>{t('wt.colConfirmOver')}</th>
                  <th>{t('wt.colActive')}</th>
                  {isAdmin && <th aria-label={t('common.actions')} />}
                </tr>
              </thead>
              <SortableContext items={codes} strategy={verticalListSortingStrategy}>
                <tbody>
                  {rows.map((w, i) => (
                    <WasteTypeRow
                      key={w.code}
                      w={w}
                      admin={isAdmin}
                      first={i === 0}
                      last={i === rows.length - 1}
                      onUp={() => move(i, i - 1)}
                      onDown={() => move(i, i + 1)}
                      onEdit={() => setEditing(w)}
                    />
                  ))}
                </tbody>
              </SortableContext>
            </table>
          </DndContext>
        </div>
      )}
      {editing && <WasteTypeDialog type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function WasteTypeRow(props: {
  w: WasteType;
  admin: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
}) {
  const { w, admin } = props;
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: w.code,
    disabled: !admin,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, position: 'relative', zIndex: isDragging ? 2 : undefined };
  return (
    <tr ref={setNodeRef} style={style} className={[isDragging ? 'dragging' : '', w.active ? '' : 'dim'].join(' ').trim() || undefined}>
      {admin && (
        <td className="nowrap">
          <button type="button" className="handle" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`${t('common.dragHandle')} ${w.code}`}>
            ⠿
          </button>
          <button type="button" className="icon-btn" disabled={props.first} onClick={props.onUp} aria-label={`${t('common.moveUp')} ${w.code}`}>
            ↑
          </button>{' '}
          <button type="button" className="icon-btn" disabled={props.last} onClick={props.onDown} aria-label={`${t('common.moveDown')} ${w.code}`}>
            ↓
          </button>
        </td>
      )}
      <td className="code">{w.code}</td>
      <td>{w.name}</td>
      <td>
        <WasteTag code={w.code} abbr={w.abbr} />
      </td>
      <td>{w.unit}</td>
      <td>{t(`wm.${w.weigh_method}`)}</td>
      <td>{w.routable ? t('common.yes') : t('common.no')}</td>
      <td>{w.routable ? '–' : w.recurring_tasks ? t('common.yes') : t('common.no')}</td>
      <td className="num">{w.confirm_over ?? '–'}</td>
      <td>{w.active ? <span className="tag ok">{t('common.active')}</span> : <span className="tag">{t('common.inactive')}</span>}</td>
      {admin && (
        <td className="actions">
          <button type="button" className="btn small" onClick={props.onEdit}>
            {t('common.edit')}
          </button>
        </td>
      )}
    </tr>
  );
}

function WasteTypeDialog({ type, onClose }: { type: WasteType | null; onClose: () => void }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const isNew = type === null;
  const [code, setCode] = useState(type?.code ?? '');
  const [name, setName] = useState(type?.name ?? '');
  const [abbr, setAbbr] = useState(type?.abbr ?? '');
  const [unit, setUnit] = useState(type?.unit ?? 'kg');
  const [weigh, setWeigh] = useState<WeighMethod>(type?.weigh_method ?? 'on_site');
  const [routable, setRoutable] = useState(type?.routable ?? false);
  const [recurring, setRecurring] = useState(type?.recurring_tasks ?? false);
  const [confirmOver, setConfirmOver] = useState(type?.confirm_over == null ? '' : String(type.confirm_over));
  const [active, setActive] = useState(type?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inUse, setInUse] = useState<WasteTypeInUseDetails | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const co = confirmOver.trim() === '' ? null : Number(confirmOver.replace(',', '.'));
    if (co !== null && !(Number.isFinite(co) && co >= 0)) return setError(t('err.VALIDATION_field', { field: t('wt.colConfirmOver') }));
    setBusy(true);
    setError(null);
    setInUse(null);
    try {
      if (isNew) {
        const c = code.trim().toUpperCase();
        const created = await createWasteType({
          code: c,
          name: name.trim(),
          abbr: (abbr.trim() || c.replace(/_/g, '')).toUpperCase(), // abbr allows no '_'
          unit: unit.trim() || 'kg',
          weigh_method: weigh,
          routable,
          recurring_tasks: routable ? false : recurring,
          confirm_over: co,
        });
        toast(t('wt.created', { code: created.code }));
      } else {
        await patchWasteType(type.code, {
          name: name.trim(),
          abbr: abbr.trim().toUpperCase(),
          weigh_method: weigh,
          recurring_tasks: type.routable ? false : recurring,
          confirm_over: co,
          active,
        });
        toast(t('common.saved'));
      }
      void qc.invalidateQueries({ queryKey: ['waste-types'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
      onClose();
    } catch (err) {
      if (isApiError(err, 'WASTE_TYPE_IN_USE')) setInUse(err.details as WasteTypeInUseDetails);
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={isNew ? t('wt.add') : t('wt.edit', { code: type.code })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="wt-form" className="btn primary" disabled={busy || !name.trim() || (isNew && !code.trim())}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form id="wt-form" className="form-grid" onSubmit={submit} noValidate>
        <label className="field">
          <span>{t('wt.colCode')}</span>
          <input
            className="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={!isNew}
            maxLength={10}
            pattern="[A-Z0-9_]{1,10}"
            spellCheck={false}
          />
          <span className="hint">{t('wt.codeHint')}</span>
        </label>
        <label className="field">
          <span>{t('wt.colName')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} data-autofocus={!isNew || undefined} />
        </label>
        <label className="field">
          <span>{t('wt.colAbbr')}</span>
          <input className="code" value={abbr} onChange={(e) => setAbbr(e.target.value.toUpperCase())} maxLength={10} placeholder={code} spellCheck={false} />
          <span className="hint">{t('wt.abbrHint')}</span>
        </label>
        <label className="field">
          <span>{t('wt.colUnit')}</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={6} disabled={!isNew} />
          <span className="hint">{t('wt.unitHint')}</span>
        </label>
        <label className="field">
          <span>{t('wt.colWeigh')}</span>
          <select value={weigh} onChange={(e) => setWeigh(e.target.value as WeighMethod)}>
            <option value="on_site">{t('wm.on_site')}</option>
            <option value="weighbridge">{t('wm.weighbridge')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('wt.colConfirmOver')}</span>
          <input value={confirmOver} onChange={(e) => setConfirmOver(e.target.value)} inputMode="decimal" />
          <span className="hint">{t('wt.confirmOverHint')}</span>
        </label>
        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={routable} disabled={!isNew} onChange={(e) => setRoutable(e.target.checked)} />
            {t('wt.colRoutable')}
          </label>
          <span className="hint">{t('wt.routableHint')}</span>
        </div>
        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={!routable && recurring} disabled={routable} onChange={(e) => setRecurring(e.target.checked)} />
            {t('wt.colRecurring')}
          </label>
          <span className="hint">{t('wt.recurringHint')}</span>
        </div>
        {!isNew && (
          <div className="field full">
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              {t('common.active')}
            </label>
            <span className="hint">{t('wt.activeHint')}</span>
          </div>
        )}
        {error && (
          <div className="full form-error" role="alert">
            {error}
          </div>
        )}
        {inUse?.routes && inUse.routes.length > 0 && (
          <div className="full small">
            <div>{t('wt.inUseRoutes')}</div>
            <ul className="list-plain">
              {inUse.routes.map((r) => (
                <li key={r.route_id}>
                  <span className="code">{r.code}</span> {r.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {inUse?.tasks && inUse.tasks.length > 0 && (
          <div className="full small">
            <div>{t('wt.inUseTasks')}</div>
            <ul className="list-plain">
              {inUse.tasks.map((tk) => (
                <li key={tk.task_id}>
                  #{tk.task_id} · {taskScheduleText(tk.schedule, t, lang)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  );
}
