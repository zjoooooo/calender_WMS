// Right-side drawer (§6.1, about 460 px): optional route colour bar in the header, scrolling body,
// sticky footer. Esc and the ✕ close it (topmost only).
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { routeColorVar } from './palette';
import { useInitialFocus, useLayer } from './layer';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Header first row (code, tag, name …); the ✕ is added at the right. */
  title: ReactNode;
  /** More header rows (rule, status line …). */
  header?: ReactNode;
  /** Route colour index 1..10: draws the 6 px colour bar at the header's left edge. */
  color?: number | null;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  label?: string;
}

export function Drawer({ open, onClose, title, header, color, children, footer, width, label }: DrawerProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  useLayer(open, onClose);
  useInitialFocus(open, panel);
  if (!open) return null;
  const style = {
    ...(width ? { ['--dw' as string]: `${width}px` } : {}),
    ...(color ? { ['--rc' as string]: routeColorVar(color) } : {}),
  } as CSSProperties;
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1} style={style}>
        <div className={color ? 'drawer-head colored' : 'drawer-head'}>
          <div className="row">
            {title}
            <button type="button" className="x-btn" onClick={onClose} aria-label={t('common.close')}>
              ✕
            </button>
          </div>
          {header}
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}
