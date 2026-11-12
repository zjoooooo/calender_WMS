// Loading and error display, and the hook that turns any thrown error into a translated text.
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api';
import { useI18n } from '../i18n';

/** Returns (error) => translated message (§10.11 codes -> err.<CODE>). */
export function useErrorText(): (e: unknown) => string {
  const { t, lang } = useI18n();
  return useCallback((e: unknown) => errorText(e, t, lang), [t, lang]);
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return <div className="muted small" role="status">{label ?? t('app.loading')}</div>;
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const text = useErrorText();
  if (!error) return null;
  return (
    <div className="banner error row" role="alert">
      <span>{text(error)}</span>
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** The value, updated only after it has been stable for `ms`. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
