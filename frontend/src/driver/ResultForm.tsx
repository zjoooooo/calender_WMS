// S4 Result form (§9.3, R27): a route stop, or a free submission of a non-routable waste type.
// - One weight field per weighable type (stop.weigh_types; route: the route's one waste type, submission:
//   the type the driver picked): "REL (kg)", inputmode=decimal, 28 px, "," accepted, a [0] chip; a value at or above
//   the type's confirm_over asks "1,250.0 kg, correct?". Every shown field is required (D12).
// - A ticket field per type whose weigh_method is weighbridge (stop.ticket_types).
// - Up to max_photos photos (resized on the phone, R35), a full-screen signature pad and a note.
// - [Collected: save] / [Not collected] (reason sheet). Reopened from Done: [Save correction] / [Undo].
// - A submission (p.submission) also asks for the truck plate (no claim picked one), has no [Not collected]
//   (nothing was planned) and its [Undo] is [Delete].
// Values are kept as a device draft on every change; a save goes to the outbox (never straight to the
// server), so it works with no signal. The form is a snapshot: polls never re-render it (§8.2, D14).
// The snapshot is taken only once this phone's outbox has been read (a fresh page load starts with an empty
// list), so an unsent result always reopens with its values, photos, signature and note.
// A single weighable type has no [0] chip (0 alone is refused): "nothing to collect" is Not collected → No
// waste. A result refused with TICKET_REQUIRED always shows that ticket field, even from an older job copy.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { prefs, type JobStop, type MissReason, type Outcome, type VisitWrite, type WasteType } from '../api';
import { fmtWeight, useI18n } from '../i18n';
import { Loading, useErrorText } from '../ui/Feedback';
import { resizePhoto } from '../ui/photo';
import { useToast } from '../ui/Toast';
import { useFileUrl } from '../ui/useFileUrl';
import { deleteDraft, draftKey, readDraft, writeDraft, type DraftValues } from './cache';
import { useDriver } from './driverContext';
import { effectiveVisit, type EffVisit } from './data';
import { ReasonPicker } from './LeaveSheet';
import { fileName, stopKey, type NotSentEntry } from './outbox';
import { LAST_PLATE, lastPlate } from './claim';
import { BottomBar, PlatePicker, Sheet, TopBar } from './parts';
import SignaturePad from './SignaturePad';

const MAX_WEIGHT = 99999.9;

/** "120,5" -> 120.5; null when not 0–99999.9 with at most 1 decimal (R27). */
export function parseWeight(s: string): number | null {
  const v = s.trim().replace(',', '.');
  if (!/^\d{1,5}(\.\d)?$/.test(v)) return null;
  const n = Number(v);
  return n <= MAX_WEIGHT ? n : null;
}

export function ContactLinks({ address, phone }: { address: string; phone: string }) {
  const { t } = useI18n();
  return (
    <div className="links">
      {address && (
        <a className="dbtn" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">
          {t('driver.navigate')}
        </a>
      )}
      {phone && (
        <a className="dbtn" href={`tel:${phone.replace(/\s+/g, '')}`}>
          {t('driver.call')}
        </a>
      )}
    </div>
  );
}

/** A photo or signature: the phone's own blob when present, otherwise fetched from the server. */
export function FileThumb({ name, onRemove, label }: { name: string; onRemove?: () => void; label?: string }) {
  const { t } = useI18n();
  const { box } = useDriver();
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void box.getFile(name).then((rec) => {
      if (!alive) return;
      if (rec) {
        url = URL.createObjectURL(rec.blob);
        setLocalUrl(url);
        setLocal(true);
      } else setLocal(false);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [box, name]);
  const server = useFileUrl(local === false && fileName(name) ? name : null);
  const src = localUrl ?? server.url;
  return (
    <div className="thumb">
      <div className="img">{src ? <img src={src} alt={label ?? t('driver.photo')} /> : label ?? t('driver.photo')}</div>
      {onRemove && (
        <button type="button" onClick={onRemove}>
          {t('driver.remove')}
        </button>
      )}
    </div>
  );
}

function initialValues(stop: JobStop, v: EffVisit | null): DraftValues {
  const weights: Record<string, string> = {};
  const tickets: Record<string, string> = {};
  for (const c of stop.weigh_types) weights[c] = v?.outcome === 'collected' && v.weights[c] !== undefined ? String(v.weights[c]) : '';
  for (const c of stop.ticket_types) tickets[c] = v?.tickets[c] ?? '';
  return { weights, tickets, photos: [...(v?.photos ?? [])], signature: v?.signature ?? null, note: v?.note ?? '' };
}

function visitOfBody(b: NotSentEntry['body'], myId: number): EffVisit {
  return {
    outcome: b.outcome,
    weights: b.weights ?? {},
    tickets: b.tickets ?? {},
    photos: b.photos ?? [],
    signature: b.signature ?? null,
    reason: b.reason ?? null,
    note: b.note ?? '',
    driver_id: myId,
    rev: b.base_rev,
    unsent: true,
  };
}

export interface ResultFormProps {
  date: string;
  job: string;
  kind: 'route' | 'submission';
  /** Route code or the submission's waste type, for the top bar and the Not sent list. */
  jobLabel: string;
  /** A free submission: its waste type, the plates to pick from and the plate it was saved with. */
  submission?: { waste_type: string; trucks: string[]; vehicle_no: string | null };
  stop: JobStop;
  wasteTypes: Record<string, WasteType>;
  maxPhotos: number;
  backTo: string;
  notsent?: NotSentEntry | null;
  afterSave: (outcome: Outcome | null) => void;
  /** Extra overflow actions. */
  menu?: ReactNode;
  at?: number;
  cached?: boolean;
}

/** The stop as the form shows it: plus the ticket field a TICKET_REQUIRED refusal asks for ("tickets.REL"). */
export function formStop(stop: JobStop, ns?: NotSentEntry | null): JobStop {
  const code = ns?.error.code === 'TICKET_REQUIRED' ? /^tickets\.(.+)$/.exec(ns.error.field ?? '')?.[1] : undefined;
  if (!code || !stop.weigh_types.includes(code) || stop.ticket_types.includes(code)) return stop;
  return { ...stop, ticket_types: [...stop.ticket_types, code] };
}

export default function ResultForm(p: ResultFormProps) {
  const { ready } = useDriver();
  if (!ready) {
    return (
      <div className="drv">
        <TopBar back={p.backTo} title={p.jobLabel} sub={p.stop.customer.name} />
        <main className="drv-main">
          <Loading />
        </main>
      </div>
    );
  }
  return <ResultFormBody {...p} />;
}

function ResultFormBody(p: ResultFormProps) {
  const { t, lang } = useI18n();
  const { me, entries, save, box } = useDriver();
  const toast = useToast();
  const errText = useErrorText();
  const cid = p.stop.customer.id;
  const dkey = draftKey(me.id, p.date, p.job, cid);

  // Snapshot at open: an open form never changes under the driver (§8.2, D14).
  const [stop] = useState(() => formStop(p.stop, p.notsent));
  const [local] = useState(() => [...entries].reverse().find((e) => e.key === stopKey(p.date, p.job, cid)) ?? null);
  const [existing] = useState<EffVisit | null>(() => (p.notsent ? visitOfBody(p.notsent.body, me.id) : effectiveVisit(p.stop, local ?? undefined, me.id)));
  const foreign = !p.notsent && !local && stop.visit?.outcome != null && stop.visit.driver_id !== me.id;
  const isCorrection = !p.notsent && existing?.outcome != null;
  const baseRev = p.notsent?.body.base_rev ?? local?.body.base_rev ?? stop.visit?.rev ?? 0;

  const [values, setValues] = useState<DraftValues>(() => initialValues(stop, existing));
  const touched = useRef(false);
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [missOpen, setMissOpen] = useState(false);
  const [reason, setReason] = useState<MissReason | null>(existing?.outcome === 'missed' ? existing.reason : null);
  const [missNote, setMissNote] = useState(existing?.outcome === 'missed' ? existing.note : '');
  const [missNoteErr, setMissNoteErr] = useState(false);
  const [over, setOver] = useState<{ code: string; kg: number }[] | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Submission: the truck plate, pre-filled with the saved one, else the plate this driver used last.
  const [plate, setPlate] = useState(() => {
    const trucks = p.submission?.trucks ?? [];
    const saved = p.notsent?.body.vehicle_no ?? local?.body.vehicle_no ?? p.submission?.vehicle_no ?? '';
    return saved && trucks.includes(saved) ? saved : lastPlate(trucks);
  });
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  // Drafts: restore once, then save on every change (§7.2).
  useEffect(() => {
    if (p.notsent) return;
    let alive = true;
    void readDraft(dkey).then((d) => {
      if (!alive || !d || touched.current) return;
      setValues({ ...initialValues(stop, existing), ...d.values });
      setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, [dkey]);
  useEffect(() => {
    if (!touched.current || p.notsent) return;
    const id = setTimeout(() => void writeDraft(dkey, values).catch(() => undefined), 250);
    return () => clearTimeout(id);
  }, [values, dkey, p.notsent]);

  const update = (fn: (v: DraftValues) => DraftValues) => {
    touched.current = true;
    setValues(fn);
  };
  const discardDraft = () => {
    void deleteDraft(dkey);
    touched.current = false;
    setValues(initialValues(stop, existing));
    setRestored(false);
  };

  const unit = (code: string) => p.wasteTypes[code]?.unit || 'kg';
  // One weighable type: 0 alone is refused, so there is no [0] chip and the hints point to Not collected.
  const single = stop.weigh_types.length === 1;
  const abbr = (code: string) => p.wasteTypes[code]?.abbr || code;

  const files = () => ({
    photos: values.photos.map((x) => fileName(x)).filter((x): x is string => !!x),
    signature: values.signature ? fileName(values.signature) : null,
  });

  const doSave = async (body: Omit<VisitWrite, 'op_id' | 'base_rev' | 'captured_at'>) => {
    setBusy(true);
    try {
      await save({
        date: p.date,
        job: p.job,
        customer_id: cid,
        body: {
          base_rev: baseRev,
          ...body,
          ...(p.submission ? { waste_type: p.submission.waste_type, customer_id: cid, vehicle_no: plate || null } : {}),
          captured_at: new Date().toISOString(),
        },
        label: { customer: stop.customer.name, job_label: p.jobLabel, kind: p.kind, weigh_types: stop.weigh_types, ticket_types: stop.ticket_types },
        replacesNotSent: p.notsent?.id,
      });
      await deleteDraft(dkey).catch(() => undefined);
      toast(t(body.outcome === null ? 'driver.toast.undone' : 'driver.toast.saved', { customer: stop.customer.name }));
      p.afterSave(body.outcome);
    } catch (e) {
      toast(errText(e), 'error');
      setBusy(false);
    }
  };

  const validateCollected = (): { weights: Record<string, number>; tickets: Record<string, string> } | null => {
    const errs: Record<string, string> = {};
    const weights: Record<string, number> = {};
    for (const code of stop.weigh_types) {
      const raw = values.weights[code] ?? '';
      if (!raw.trim()) errs['w.' + code] = t(single ? 'driver.form.weightRequiredOne' : 'driver.form.weightRequired');
      else {
        const n = parseWeight(raw);
        if (n === null) errs['w.' + code] = t('err.WEIGHT_INVALID');
        else weights[code] = n;
      }
    }
    if (!Object.keys(errs).length && !Object.values(weights).some((n) => n > 0)) errs.form = t(single ? 'driver.form.weightZeroOne' : 'err.WEIGHT_REQUIRED');
    const tickets: Record<string, string> = {};
    for (const code of stop.ticket_types) {
      if (!((weights[code] ?? 0) > 0)) continue;
      const s = (values.tickets[code] ?? '').trim();
      if (!s) errs['t.' + code] = t('err.TICKET_REQUIRED');
      else if (s.length > 30) errs['t.' + code] = t('driver.form.ticketTooLong');
      else tickets[code] = s;
    }
    if (p.submission && !plate) errs.plate = t('err.VEHICLE_REQUIRED');
    else if (p.submission) prefs.set(LAST_PLATE, plate);
    setErrors(errs);
    return Object.keys(errs).length ? null : { weights, tickets };
  };

  const collected = (confirmed = false) => {
    const v = validateCollected();
    if (!v) return;
    if (!confirmed) {
      const big = Object.entries(v.weights)
        .filter(([code, kg]) => {
          const lim = p.wasteTypes[code]?.confirm_over;
          return lim != null && kg >= lim;
        })
        .map(([code, kg]) => ({ code, kg }));
      if (big.length) return setOver(big);
    }
    setOver(null);
    void doSave({ outcome: 'collected', weights: v.weights, tickets: v.tickets, ...files(), reason: null, note: values.note.trim() });
  };

  const missed = () => {
    if (!reason) return;
    if (reason === 'other' && !missNote.trim()) return setMissNoteErr(true);
    setMissOpen(false);
    void doSave({ outcome: 'missed', weights: {}, tickets: {}, ...files(), reason, note: missNote.trim() });
  };

  const addPhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setPhotoBusy(true);
    try {
      for (const f of Array.from(list)) {
        if (values.photos.length >= p.maxPhotos) break;
        try {
          const blob = await resizePhoto(f);
          const name = await box.addFile(blob, 'jpg');
          update((v) => (v.photos.length >= p.maxPhotos ? v : { ...v, photos: [...v.photos, name] }));
        } catch {
          toast(t('driver.photo.failed'), 'error');
        }
      }
    } finally {
      setPhotoBusy(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  const ticketFor = (code: string) => stop.ticket_types.includes(code);
  const weightOf = (v: EffVisit) =>
    Object.entries(v.weights)
      .map(([c, w]) => `${abbr(c)} ${fmtWeight(Number(String(w).replace(',', '.')))} ${unit(c)}`)
      .join(' · ');

  return (
    <div className="drv has-bar">
      <TopBar back={p.backTo} title={p.jobLabel} sub={stop.customer.name} at={p.at} cached={p.cached} right={p.menu} />
      <main className="drv-main" data-testid="result-form">
        {p.notsent && (
          <div className="dban error" role="alert">
            {t('driver.notsent.editing')}
          </div>
        )}
        {restored && (
          <div className="dban info">
            <span className="grow">{t('driver.form.restored')}</span>
            <button type="button" className="link" onClick={discardDraft}>
              {t('driver.form.discard')}
            </button>
          </div>
        )}
        {isCorrection && !foreign && <div className="dban warn">{t('driver.form.correcting')}</div>}

        <div className="cust stack">
          <h1>{stop.customer.name}</h1>
          <div>{stop.customer.address}</div>
          <ContactLinks address={stop.customer.address} phone={stop.customer.phone} />
          {stop.stop_note && <div className="dban info">{stop.stop_note}</div>}
          {stop.customer.note && <div className="meta">{stop.customer.note}</div>}
          {stop.also_on.map((a) => (
            <div key={a.job} className="meta">
              {t('driver.alsoOn', { what: a.label })}
              {a.outcome ? ` (${a.outcome === 'collected' ? '✓' : '✗'})` : ''}
            </div>
          ))}
        </div>

        {foreign && existing ? (
          <div className="visit-ro">
            <b>{existing.outcome === 'collected' ? '✓ ' + weightOf(existing) : '✗ ' + t('driver.reason.' + (existing.reason ?? 'other'))}</b>
            {existing.note && <span>{existing.note}</span>}
            <span className="dban warn">{t('driver.form.foreign')}</span>
          </div>
        ) : (
          <>
            {stop.weigh_types.map((code) => (
              <div key={code} className={errors['w.' + code] ? 'dfield invalid' : 'dfield'}>
                <label htmlFor={`w-${code}`}>{t('driver.form.weightLabel', { type: abbr(code), unit: unit(code) })}</label>
                <div className="kg">
                  <input
                    id={`w-${code}`}
                    name={`weight-${code}`}
                    inputMode="decimal"
                    autoComplete="off"
                    enterKeyHint="done"
                    value={values.weights[code] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      update((x) => ({ ...x, weights: { ...x.weights, [code]: v } }));
                    }}
                  />
                  {!single && (
                    <button type="button" className="zero" onClick={() => update((x) => ({ ...x, weights: { ...x.weights, [code]: '0' } }))}>
                      0
                    </button>
                  )}
                </div>
                {errors['w.' + code] && <span className="err">{errors['w.' + code]}</span>}
                {ticketFor(code) && (
                  <label className={errors['t.' + code] ? 'dfield invalid' : 'dfield'}>
                    <span>{t('driver.form.ticket', { type: abbr(code) })}</span>
                    <input
                      name={`ticket-${code}`}
                      maxLength={30}
                      autoComplete="off"
                      value={values.tickets[code] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        update((x) => ({ ...x, tickets: { ...x.tickets, [code]: v } }));
                      }}
                    />
                    {errors['t.' + code] && <span className="err">{errors['t.' + code]}</span>}
                  </label>
                )}
              </div>
            ))}
            {errors.form && (
              <div className="form-err" role="alert">
                {errors.form}
              </div>
            )}
            {p.submission && (
              <div className={errors.plate ? 'dfield invalid' : 'dfield'}>
                <PlatePicker trucks={p.submission.trucks} value={plate} onChange={setPlate} />
                {errors.plate && <span className="err">{errors.plate}</span>}
              </div>
            )}

            <div className="stack">
              {values.photos.length > 0 && (
                <div className="thumbs" data-testid="photos">
                  {values.photos.map((n) => (
                    <FileThumb key={n} name={n} onRemove={() => update((v) => ({ ...v, photos: v.photos.filter((x) => x !== n) }))} />
                  ))}
                </div>
              )}
              <input
                ref={photoInput}
                className="visually-hidden"
                type="file"
                accept="image/*"
                capture="environment"
                data-testid="photo-input"
                tabIndex={-1}
                onChange={(e) => void addPhotos(e.target.files)}
              />
              <button type="button" className="dbtn" disabled={photoBusy || values.photos.length >= p.maxPhotos} onClick={() => photoInput.current?.click()}>
                {photoBusy ? t('driver.photo.working') : t('driver.photo.add', { n: values.photos.length, max: p.maxPhotos })}
              </button>
            </div>

            <div className="stack">
              {values.signature && (
                <div className="sigprev" data-testid="signature">
                  <FileThumb name={values.signature} label={t('driver.sig.title')} />
                </div>
              )}
              <div className="dbtns">
                <button type="button" className="dbtn" onClick={() => setSigOpen(true)}>
                  {values.signature ? t('driver.sig.again') : t('driver.sig.open')}
                </button>
                {values.signature && (
                  <button type="button" className="dbtn" onClick={() => update((v) => ({ ...v, signature: null }))}>
                    {t('driver.sig.remove')}
                  </button>
                )}
              </div>
            </div>

            <label className="dfield">
              <span>
                {t('common.note')} ({t('common.optional')})
              </span>
              <textarea name="note" maxLength={500} value={values.note} onChange={(e) => {
                const v = e.target.value;
                update((x) => ({ ...x, note: v }));
              }} />
            </label>
          </>
        )}
      </main>

      <BottomBar>
        {foreign ? (
          <button type="button" className="dbtn primary big" onClick={() => p.afterSave(existing?.outcome ?? null)}>
            {t('driver.back')}
          </button>
        ) : (
          <>
            <button type="button" className="dbtn go big" data-testid="save-collected" disabled={busy} onClick={() => collected(false)}>
              {isCorrection ? t('driver.form.saveCorrection') : t('driver.form.collected')}
            </button>
            <div className={isCorrection && !p.submission ? 'dbtns' : ''}>
              {!p.submission && (
                <button type="button" className="dbtn" data-testid="not-collected" disabled={busy} onClick={() => setMissOpen(true)}>
                  {t('driver.form.notCollected')}
                </button>
              )}
              {isCorrection && (
                <button type="button" className="dbtn warn" data-testid="undo" disabled={busy} onClick={() => void doSave({ outcome: null })}>
                  {t(p.submission ? 'driver.submit.delete' : 'driver.form.undo')}
                </button>
              )}
            </div>
          </>
        )}
      </BottomBar>

      <Sheet open={missOpen} title={t('driver.form.whyNot')} onClose={() => setMissOpen(false)} busy={busy} testId="miss-sheet">
        <ReasonPicker
          reason={reason}
          note={missNote}
          onReason={(r) => {
            setReason(r);
            setMissNoteErr(false);
          }}
          onNote={(n) => {
            setMissNote(n);
            setMissNoteErr(false);
          }}
          noteError={missNoteErr}
        />
        <button type="button" className="dbtn primary big" disabled={busy || !reason} onClick={missed}>
          {t('driver.form.saveMissed')}
        </button>
        <button type="button" className="dbtn" onClick={() => setMissOpen(false)}>
          {t('common.cancel')}
        </button>
      </Sheet>

      <Sheet open={!!over} title={t('driver.form.checkTitle')} onClose={() => setOver(null)} testId="over-sheet">
        {over?.map((o) => (
          <div key={o.code} className="prog">
            {t('driver.form.checkWeight', { type: abbr(o.code), kg: (Math.round(o.kg * 10) / 10).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), unit: unit(o.code) })}
          </div>
        ))}
        <button type="button" className="dbtn go big" onClick={() => collected(true)}>
          {t('driver.form.checkYes')}
        </button>
        <button type="button" className="dbtn" onClick={() => setOver(null)}>
          {t('driver.form.checkNo')}
        </button>
      </Sheet>

      {sigOpen && (
        <SignaturePad
          onCancel={() => setSigOpen(false)}
          onSave={async (blob) => {
            const name = await box.addFile(blob, 'png');
            update((v) => ({ ...v, signature: name }));
            setSigOpen(false);
          }}
        />
      )}
    </div>
  );
}
