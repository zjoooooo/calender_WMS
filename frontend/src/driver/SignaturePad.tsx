// Full-screen finger signature pad (§9.3 S4) with Clear and Save. Pointer events cover finger, pen and
// mouse; touch-action:none keeps the page from scrolling while signing. Saves a PNG (white background,
// at most 2x pixel density) within the server's 300 KB cap (R35).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { canvasToPng, MAX_PNG_BYTES } from '../ui/photo';

export default function SignaturePad({ onSave, onCancel }: { onSave: (png: Blob) => void | Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [ink, setInk] = useState(false);
  const [busy, setBusy] = useState(false);

  const ratio = () => Math.min(2, window.devicePixelRatio || 1);

  const reset = () => {
    const c = ref.current;
    if (!c) return;
    const r = ratio();
    c.width = Math.max(1, Math.round(c.clientWidth * r));
    c.height = Math.max(1, Math.round(c.clientHeight * r));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    setInk(false);
  };

  useEffect(() => {
    reset();
    const onResize = () => reset();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = point(e);
    drawing.current = p;
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
    }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const p = point(e);
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(drawing.current.x, drawing.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    drawing.current = p;
    if (!ink) setInk(true);
  };
  const up = () => {
    drawing.current = null;
  };

  const save = async () => {
    const c = ref.current;
    if (!c) return;
    setBusy(true);
    try {
      let blob = await canvasToPng(c);
      if (blob.size > MAX_PNG_BYTES) {
        // very rare: redraw at 1x
        const small = document.createElement('canvas');
        small.width = c.clientWidth;
        small.height = c.clientHeight;
        small.getContext('2d')?.drawImage(c, 0, 0, small.width, small.height);
        blob = await canvasToPng(small);
      }
      await onSave(blob);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="sigpad" role="dialog" aria-modal="true" aria-label={t('driver.sig.title')}>
      <div className="sp-head">{t('driver.sig.hint')}</div>
      <canvas ref={ref} data-testid="sig-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="sp-foot">
        <button type="button" className="dbtn" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="button" className="dbtn" onClick={reset} disabled={busy}>
          {t('driver.sig.clear')}
        </button>
        <button type="button" className="dbtn primary" onClick={save} disabled={busy || !ink}>
          {t('driver.sig.save')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
