// Customers page (§9.2, §6.9, R4): searchable table (code, name, address, waste-type tags, routes),
// archived filter, create / edit (CustomerFormDialog), Archive with a removal preview and a
// result list, Restore.
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  archiveCustomer,
  getCustomer,
  isApiError,
  listCustomers,
  listWasteTypes,
  restoreCustomer,
  type Customer,
  type CustomerListItem,
  type RemovedItem,
} from '../api';
import { useI18n } from '../i18n';
import { WasteTag } from '../ui/Chip';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { ErrorBanner, Loading, useDebounced, useErrorText } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { CustomerFormDialog } from './CustomerFormDialog';
import { removedItemText, typeMap } from './labels';
import { RunExistsDialog } from './RunExistsDialog';

type ArchivedFilter = '0' | '1' | 'all';

export default function CustomersPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [archived, setArchived] = useState<ArchivedFilter>('0');
  const [type, setType] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [archiving, setArchiving] = useState<CustomerListItem | null>(null);
  const [restoring, setRestoring] = useState<CustomerListItem | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const typesQ = useQuery({ queryKey: ['waste-types'], queryFn: listWasteTypes });
  const types = typeMap(typesQ.data);
  const listQ = useQuery({
    queryKey: ['customers', { q: dq, archived, type }],
    queryFn: () => listCustomers({ q: dq, archived, type: type || undefined }),
    placeholderData: keepPreviousData,
  });
  const rows = listQ.data ?? [];

  const doRestore = async () => {
    if (!restoring) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await restoreCustomer(restoring.id);
      toast(t('customers.restored', { name: restoring.name }));
      setRestoring(null);
      void qc.invalidateQueries({ queryKey: ['customers'] });
    } catch (e) {
      setRestoreError(errText(e));
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('customers.title')}</h1>
        <input
          className="search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('customers.searchPlaceholder')}
          aria-label={t('common.search')}
        />
        <div className="seg" role="group" aria-label={t('common.archived')}>
          {(['0', '1', 'all'] as ArchivedFilter[]).map((v) => (
            <button key={v} type="button" aria-pressed={archived === v} onClick={() => setArchived(v)}>
              {t(v === '0' ? 'customers.filterActive' : v === '1' ? 'customers.filterArchived' : 'customers.filterAll')}
            </button>
          ))}
        </div>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('customers.colTypes')}>
          <option value="">{t('customers.allTypes')}</option>
          {(typesQ.data ?? []).map((w) => (
            <option key={w.code} value={w.code}>
              {w.abbr || w.code}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span className="muted small">{listQ.data ? t('customers.count', { n: rows.length }) : ''}</span>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          + {t('customers.new')}
        </button>
      </div>

      <ErrorBanner error={listQ.error} onRetry={() => listQ.refetch()} />
      {listQ.isLoading && <Loading />}

      {listQ.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('customers.colCode')}</th>
                <th>{t('customers.colName')}</th>
                <th>{t('customers.colAddress')}</th>
                <th>{t('customers.colPhone')}</th>
                <th>{t('customers.colTypes')}</th>
                <th>{t('customers.colRoutes')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t('customers.empty')}
                  </td>
                </tr>
              )}
              {rows.map((c) => (
                <tr key={c.id} className={c.active ? 'clickable' : 'clickable dim'} onClick={() => setEditing(c)}>
                  <td className="code nowrap">{c.code}</td>
                  <td>
                    {c.name} {!c.active && <span className="tag">{t('common.archived')}</span>}
                    {c.note && <div className="muted small ellipsis" style={{ maxWidth: 260 }}>{c.note}</div>}
                  </td>
                  <td className="small">{c.address}</td>
                  <td className="small nowrap">{c.phone}</td>
                  <td>
                    <span className="chips">
                      {c.waste_types.map((code) => (
                        <WasteTag key={code} code={code} abbr={types[code]?.abbr} inactive={types[code] ? !types[code].active : false} />
                      ))}
                    </span>
                  </td>
                  <td className="small">
                    <span className="chips">
                      {c.routes.map((r) => (
                        <span key={r} className="code">{r}</span>
                      ))}
                    </span>
                  </td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn small" onClick={() => setEditing(c)}>
                      {t('common.edit')}
                    </button>
                    {c.active ? (
                      <button type="button" className="btn small" onClick={() => setArchiving(c)}>
                        {t('customers.archive')}
                      </button>
                    ) : (
                      <button type="button" className="btn small" onClick={() => { setRestoreError(null); setRestoring(c); }}>
                        {t('customers.restore')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CustomerFormDialog
        open={editing !== null}
        customer={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
      {archiving && <ArchiveDialog customer={archiving} onClose={() => setArchiving(null)} />}
      <ConfirmDialog
        open={!!restoring}
        title={`${t('customers.restore')} ${restoring?.name ?? ''}`}
        confirmLabel={t('customers.restore')}
        busy={restoreBusy}
        error={restoreError}
        onClose={() => setRestoring(null)}
        onConfirm={doRestore}
      >
        <p style={{ margin: 0 }}>{t('customers.restoreNote')}</p>
      </ConfirmDialog>
    </>
  );
}

/** Archive = detach every type, then active = false (R4). Preview first, then the result list. */
function ArchiveDialog({ customer, onClose }: { customer: CustomerListItem; onClose: () => void }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const errText = useErrorText();
  const detailQ = useQuery({ queryKey: ['customer', customer.id], queryFn: () => getCustomer(customer.id), staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<ApiError | null>(null);
  const [removed, setRemoved] = useState<RemovedItem[] | null>(null);

  const run = async (releaseRun = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await archiveCustomer(customer.id, releaseRun ? { release_run: true } : {});
      setRemoved(r.removed);
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    } catch (e) {
      if (isApiError(e, 'RUN_EXISTS')) setRunErr(e);
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const d = detailQ.data;
  const nothing = d && d.routes.length === 0;

  if (removed) {
    return (
      <Dialog
        open
        title={t('customers.archivedTitle', { name: customer.name })}
        onClose={onClose}
        width={480}
        footer={
          <button type="button" className="btn primary" onClick={onClose} data-autofocus>
            {t('common.close')}
          </button>
        }
      >
        {removed.length === 0 ? (
          <p style={{ margin: 0 }}>{t('customers.archiveNothing')}</p>
        ) : (
          <>
            <div>{t('customers.archivedRemoved')}</div>
            <ul className="list-plain">
              {removed.map((it, i) => (
                <li key={i}>{removedItemText(it, t, lang)}</li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
    );
  }

  return (
    <>
      <Dialog
        open
        title={t('customers.archiveTitle', { name: customer.name })}
        onClose={onClose}
        width={480}
        footer={
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn danger" disabled={busy || !d} onClick={() => run()}>
              {t('customers.archiveConfirm')}
            </button>
          </>
        }
      >
        {detailQ.isLoading && <Loading />}
        <ErrorBanner error={detailQ.error} />
        {d && nothing && <p style={{ margin: 0 }}>{t('customers.archiveNothing')}</p>}
        {d && !nothing && (
          <>
            <div>{t('customers.archivePreview')}</div>
            <ul className="list-plain">
              {d.routes.map((r) => (
                <li key={`r${r.route_id}`}>{t('customers.previewRoute', { code: r.code, name: r.name })}</li>
              ))}
            </ul>
          </>
        )}
        <div className="note">{t('customers.restoreNote')}</div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </Dialog>
      <RunExistsDialog
        error={runErr}
        busy={busy}
        onClose={() => setRunErr(null)}
        onRelease={() => {
          setRunErr(null);
          void run(true);
        }}
      />
    </>
  );
}
