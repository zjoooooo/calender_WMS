// Office result dialog (§6.12, R27, R29, R30): view, enter or correct one customer's result on a job.
// - outcome (collected / not collected), a weight per weighable type and tickets for weighbridge types;
// - photos (view, add with resize + upload, remove) and signature (view, remove);
// - reason and note; driver (new visit only); WHY, required when changing an existing visit;
// - the history: every revision, who wrote it, when and why, rejected bodies marked.
// Works on any date ≤ today; a first visit on a job without a run creates a holder-less run (back-fill).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fileNameOf,
  getRun,
  isApiError,
  listDrivers,
  MISS_REASONS,
  putRunStop,
  uploadFile,
  type MissReason,
  type Outcome,
  type Visit,
  type VisitHistoryEntry,
} from '../api';
import { fmtDateTime, fmtWeight, useI18n } from '../i18n';
import { useSession } from '../session';
import { Dialog } from '../ui/Dialog';
import { Loading, useErrorText } from '../ui/Feedback';
import { resizePhoto } from '../ui/photo';
import { useToast } from '../ui/Toast';
import { useFileUrl } from '../ui/useFileUrl';
import { uuidv4 } from '../ui/uuid';
import { useInvalidatePlan } from './officeShared';

export interface ResultTarget {
  date: string;
  job: string; // 'r5' | 't6'
  customerId: number;
  customerName: string;
  /** Codes the visit may weigh: route = the customer's active routable types; task = the task's type. */
  weighTypes: string[];
  /** Holder or last driver, the default "driver" of a new visit. */
  defaultDriverId?: number | null;
}

function findVisit(detail: any, cid: number): Visit | null {
  if (!detail) return null;
  const v = detail.visits?.[String(cid)];
  if (v) return v as Visit;
  const stop = (detail.stops ?? []).find((s: any) => s.customer?.id === cid);
  return (stop?.visit as Visit) ?? null;
}

export function ResultDialog({ target, onClose }: { target: ResultTarget; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { meta } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const invalidate = useInvalidatePlan();
  const runQ = useQuery({
    queryKey: ['run', target.date, target.job],
    queryFn: () => getRun(target.date, target.job),
    retry: false,
  });
  const noRun = isApiError(runQ.error, 'NOT_FOUND');
  const driversQ = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const visit = findVisit(runQ.data, target.customerId);
  const existing = !!visit && visit.outcome !== null;
  const types = useMemo(() => (meta?.waste_types ?? []).filter((w) => target.weighTypes.includes(w.code)), [meta, target.weighTypes]);

  const [outcome, setOutcome] = useState<Outcome | null>('collected');
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [tickets, setTickets] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [reason, setReason] = useState<MissReason>('closed');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const [driverId, setDriverId] = useState<number | null>(target.defaultDriverId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmBig, setConfirmBig] = useState<string | null>(null);
  const [loadedRev, setLoadedRev] = useState<number | null>(null);

  // Fill the form from the stored visit (again when another write changed it).
  useEffect(() => {
    if (!runQ.isSuccess && !noRun) return;
    const rev = visit?.rev ?? 0;
    if (loadedRev === rev) return;
    setLoadedRev(rev);
    if (visit && visit.outcome) {
      setOutcome(visit.outcome);
      setWeights(Object.fromEntries(Object.entries(visit.weights ?? {}).map(([k, v]) => [k, String(v)])));
      setTickets({ ...(visit.tickets ?? {}) });
      setPhotos([...(visit.photos ?? [])]);
      setSignature(visit.signature ?? null);
      if (visit.reason) setReason(visit.reason);
      setNote(visit.note ?? '');
    }
  }, [runQ.isSuccess, noRun, visit, loadedRev]);

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const f of Array.from(files)) {
      if (photos.length >= (meta?.config.max_photos ?? 5)) break;
      try {
        const blob = await resizePhoto(f);
        const id = uuidv4();
        const r = await uploadFile(id, 'jpg', blob);
        setPhotos((p) => [...p, r.data.path]);
      } catch (e) {
        setError(errText(e));
      }
    }
  };

  const save = async (undo = false) => {
    setError(null);
    if (existing && !why.trim()) return setError(t('err.WHY_REQUIRED'));
    const o: Outcome | null = undo ? null : outcome;
    const w: Record<string, string> = {};
    if (o === 'collected') {
      for (const ty of types) {
        const raw = (weights[ty.code] ?? '').trim().replace(',', '.');
        if (raw !== '') w[ty.code] = raw;
      }
      const big = types.find((ty) => ty.confirm_over !== null && Number(w[ty.code] ?? 0) >= (ty.confirm_over ?? Infinity));
      if (big && confirmBig !== JSON.stringify(w)) {
        setConfirmBig(JSON.stringify(w));
        return setError(t('result.confirmBig', { w: `${fmtWeight(Number(w[big.code]))} ${big.unit}` }));
      }
    }
    setBusy(true);
    try {
      const r = await putRunStop(target.date, target.job, target.customerId, {
        op_id: uuidv4(),
        base_rev: visit?.rev ?? 0,
        outcome: o,
        weights: o === 'collected' ? Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v)])) : {},
        tickets: o === 'collected' ? Object.fromEntries(types.filter((ty) => ty.weigh_method === 'weighbridge' && tickets[ty.code]?.trim()).map((ty) => [ty.code, tickets[ty.code].trim()])) : {},
        photos: o ? photos.map(fileNameOf) : [],
        signature: o && signature ? fileNameOf(signature) : null,
        reason: o === 'missed' ? reason : null,
        note: o ? note.trim() : '',
        why: existing ? why.trim() : null,
        ...(!visit ? { driver_id: driverId } : {}),
      });
      for (const wn of r.warnings) toast(t(`warn.${wn.code}`), 'warn');
      if (!r.warnings.length) toast(t('result.saved', { name: target.customerName }));
      invalidate();
      onClose();
    } catch (e) {
      setError(errText(e));
      if (isApiError(e, 'VISIT_CHANGED')) void runQ.refetch();
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  const history: VisitHistoryEntry[] = [...(visit?.history ?? [])].reverse();
  const loading = runQ.isLoading;
  return (
    <Dialog
      open
      width={560}
      title={t('result.title', { name: target.customerName })}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => save(true)} title={t('result.undoHint')}>
              {t('result.undo')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || loading} onClick={() => save(false)}>
            {confirmBig ? t('result.yesSave') : t('common.save')}
          </button>
        </>
      }
    >
      {loading && <Loading />}
      {runQ.error && !noRun ? <div className="form-error">{errText(runQ.error)}</div> : null}
      {visit?.flags?.length ? (
        <div className="row">
          {visit.flags.map((f) => (
            <span key={f} className="flag">
              {f}
            </span>
          ))}
        </div>
      ) : null}
      <div className="seg" role="radiogroup" aria-label={t('result.outcome')}>
        <button type="button" aria-pressed={outcome === 'collected'} onClick={() => setOutcome('collected')}>
          ✓ {t('result.collected')}
        </button>
        <button type="button" aria-pressed={outcome === 'missed'} onClick={() => setOutcome('missed')}>
          ✗ {t('status.notCollected')}
        </button>
      </div>
      {outcome === 'collected' &&
        types.map((ty) => (
          <div key={ty.code} className="stack" style={{ gap: 6 }}>
            <label className="kg">
              <span className="wtag">{ty.abbr || ty.code}</span>
              <input
                className="input num"
                inputMode="decimal"
                value={weights[ty.code] ?? ''}
                placeholder="0"
                aria-label={`${ty.code} (${ty.unit})`}
                onChange={(e) => {
                  setConfirmBig(null);
                  setWeights((s) => ({ ...s, [ty.code]: e.target.value }));
                }}
              />
              <span className="unit">{ty.unit}</span>
            </label>
            {ty.weigh_method === 'weighbridge' && (
              <label className="field">
                <span>{t('result.ticket', { type: ty.abbr || ty.code })}</span>
                <input value={tickets[ty.code] ?? ''} maxLength={30} onChange={(e) => setTickets((s) => ({ ...s, [ty.code]: e.target.value }))} />
              </label>
            )}
          </div>
        ))}
      {outcome === 'missed' && (
        <label className="field">
          <span>{t('result.reason')}</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as MissReason)}>
            {MISS_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason.${r}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t('common.note')}</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="field">
        <span>{t('result.photos')}</span>
        <div className="thumbs">
          {photos.map((p) => (
            <Thumb key={p} path={p} onRemove={() => setPhotos((s) => s.filter((x) => x !== p))} />
          ))}
          {photos.length < (meta?.config.max_photos ?? 5) && (
            <label className="thumb" style={{ cursor: 'pointer' }}>
              + {t('result.addPhoto')}
              <input type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
            </label>
          )}
        </div>
      </div>
      {signature && (
        <div className="field">
          <span>{t('result.signature')}</span>
          <div className="thumbs">
            <Thumb path={signature} onRemove={() => setSignature(null)} />
          </div>
        </div>
      )}
      {!visit && (
        <label className="field">
          <span>{t('result.driver')}</span>
          <select value={driverId ?? ''} onChange={(e) => setDriverId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('common.none')}</option>
            {(driversQ.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {existing && (
        <label className="field">
          <span>{t('result.why')}</span>
          <input value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} placeholder={t('result.whyPlaceholder')} />
        </label>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {history.length > 0 && (
        <div className="history">
          <strong>{t('result.history')}</strong>
          {history.map((h, i) => (
            <div key={i} className={h.rejected ? 'h rejected' : 'h'}>
              <div>
                <span className="code">r{h.rev}</span> · {fmtDateTime(h.at, lang)} · {h.by}
                {h.rejected && <span className="flag"> {t('result.rejected')}</span>}
              </div>
              <div className="muted">
                {h.outcome === 'collected'
                  ? Object.entries(h.weights ?? {})
                      .map(([k, v]) => `${k} ${fmtWeight(Number(v))}`)
                      .join(' · ')
                  : h.outcome === 'missed'
                    ? `${t('status.notCollected')} · ${h.reason ? t(`reason.${h.reason}`) : ''}`
                    : t('result.undone')}
                {h.note ? ` · ${h.note}` : ''}
                {h.why ? ` · ${t('result.whyShort')}: ${h.why}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function Thumb({ path, onRemove }: { path: string; onRemove: () => void }) {
  const { t } = useI18n();
  const { url } = useFileUrl(path);
  return (
    <div className="thumb">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="" />
        </a>
      ) : (
        '…'
      )}
      <button type="button" className="x" onClick={onRemove} aria-label={t('common.delete')}>
        ✕
      </button>
    </div>
  );
}
