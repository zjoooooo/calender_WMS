// Modal dialog: scrim, title, body, footer. Esc and the ✕ close it (topmost only).
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useInitialFocus, useLayer } from './layer';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** Width in px (default 520). */
  width?: number;
  /** Click on the scrim closes (default false, so a half-filled form is not lost). */
  closeOnScrim?: boolean;
  /** Hide the ✕ and ignore Esc (for a forced step). */
  noClose?: boolean;
  /** Extra class on the panel (e.g. "print-doc": the dialog is what a print shows). */
  className?: string;
}

export function Dialog({ open, title, onClose, children, footer, width, closeOnScrim, noClose, className }: DialogProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  useLayer(open, () => !noClose && onClose());
  useInitialFocus(open, panel);
  if (!open) return null;
  const style = width ? ({ ['--dw' as string]: `${width}px` } as CSSProperties) : undefined;
  return createPortal(
    <>
      <div className="scrim" onClick={closeOnScrim && !noClose ? onClose : undefined} />
      <div className={className ? `dialog ${className}` : 'dialog'} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={panel} tabIndex={-1} style={style}>
        <div className="dialog-head">
          <h2>{title}</h2>
          {!noClose && (
            <button type="button" className="x-btn" onClick={onClose} aria-label={t('common.close')}>
              ✕
            </button>
          )}
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

/** A yes/no confirmation built on Dialog. */
export function ConfirmDialog(props: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={props.open}
      title={props.title}
      onClose={props.onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={props.danger ? 'btn danger' : 'btn primary'}
            onClick={props.onConfirm}
            disabled={props.busy}
            data-autofocus
          >
            {props.confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      {props.children}
      {props.error && <div className="form-error">{props.error}</div>}
    </Dialog>
  );
}
