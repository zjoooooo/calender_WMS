// The demo banner above every page (§11.5): sample data, changes stay in this browser, [Reset demo data],
// and the notices of this start (data reset by an update, storage not allowed, the demo changed in another
// tab, with [Reload this page]). Rendered inside the app, so it follows the app's language and can sign in
// again if the session ever loses its token.
import { useEffect, useState } from 'react';
import type { LoginResult } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { ConfirmDialog } from '../ui/Dialog';
import { DEMO_DRIVER } from './mode';
import type { SaveState } from './storage';
import { demoText, type DemoKey } from './texts';

export interface DemoControl {
  notices: DemoKey[];
  saveState: () => SaveState;
  onSaveState: (fn: (s: SaveState) => void) => () => void;
  /** Signs in as the demo admin. */
  signIn: () => Promise<LoginResult>;
  /** Drops the saved copy and reloads: the demo starts again from the bundled data. */
  reset: () => Promise<void>;
}

export function DemoBar({ control }: { control: DemoControl }) {
  const { lang } = useI18n();
  const s = useSession();
  const [save, setSave] = useState<SaveState>(control.saveState);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => control.onSaveState(setSave), [control]);

  // A 401 signs the session out (session.tsx); the demo has no sign-in page, so it signs in again.
  const { token, signIn } = s;
  useEffect(() => {
    if (token) return;
    let live = true;
    control.signIn().then((r) => live && signIn(r), () => undefined);
    return () => {
      live = false;
    };
  }, [token, signIn, control]);

  // Another tab changed the demo (the driver page saved a stop, the office page a route): this tab's own
  // backend still has the old data. Load the new data by itself, so the two pages follow each other like
  // the real app's two screens; wait while the visitor is typing or has a dialog or a stop form open (the
  // notice and its button stay until then).
  useEffect(() => {
    if (save !== 'otherTab') return;
    const busy = () =>
      /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || !!document.querySelector('.dialog, [data-testid="result-form"]');
    const go = () => !busy() && location.reload();
    go();
    const timer = setInterval(go, 1500);
    return () => clearInterval(timer);
  }, [save]);

  const t = (k: DemoKey) => demoText(lang, k);
  const notices =
    save === 'off' ? [...control.notices, 'notice.noStorage' as const]
    : save === 'otherTab' ? [...control.notices, 'notice.otherTab' as const]
    : control.notices;
  return (
    <div className="demo-bar" role="region" aria-label={t('title')}>
      <span>{t(DEMO_DRIVER ? 'bar.textDriver' : 'bar.text')}</span>
      {/* the other demo page: the same data, saved in this browser */}
      <a className="btn small" href={DEMO_DRIVER ? '../' : './driver/'} data-testid="demo-other">
        {t(DEMO_DRIVER ? 'bar.toOffice' : 'bar.toDriver')}
      </a>
      {notices.map((k) => (
        <strong key={k} className="demo-notice">
          {t(k)}
        </strong>
      ))}
      {save === 'otherTab' && (
        <button type="button" className="btn small primary" onClick={() => location.reload()}>
          {t('bar.reload')}
        </button>
      )}
      <button type="button" className="btn small" onClick={() => setConfirm(true)}>
        {t('bar.reset')}
      </button>
      <ConfirmDialog
        open={confirm}
        title={t('bar.resetTitle')}
        confirmLabel={t('bar.reset')}
        danger
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setBusy(true);
          void control.reset();
        }}
      >
        <p style={{ margin: 0 }}>{t('bar.resetText')}</p>
      </ConfirmDialog>
    </div>
  );
}
