// 千里江山 | 简约: the look of the office pages (src/ui/style.ts), remembered in this browser.
import { useState } from 'react';
import { useI18n } from '../i18n';
import { LOOKS, getLook, setLook } from './style';

export function StyleSwitch() {
  const { t } = useI18n();
  const [look, set] = useState(getLook);
  return (
    <div className="seg" role="group" aria-label={t('style.label')} data-testid="style-switch">
      {LOOKS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={look === l}
          onClick={() => {
            setLook(l);
            set(l);
          }}
        >
          {t(`style.${l}`)}
        </button>
      ))}
    </div>
  );
}
