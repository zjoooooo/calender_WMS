// 中文 | EN switch. Signed in: saved on the user (PATCH /api/me). Signed out: remembered in this browser.
import { useState } from 'react';
import type { Lang } from '../api';
import { LANGS, useI18n } from '../i18n';
import { useSession } from '../session';
import { useErrorText } from './Feedback';
import { useToast } from './Toast';

export function LangSwitch({ className }: { className?: string }) {
  const { lang, t } = useI18n();
  const { changeLang } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const pick = async (l: Lang) => {
    if (l === lang || busy) return;
    setBusy(true);
    try {
      await changeLang(l);
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={t('lang.label')}>
      {LANGS.map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => pick(l)}>
          {l === 'zh' ? '中文' : 'EN'}
        </button>
      ))}
    </div>
  );
}
