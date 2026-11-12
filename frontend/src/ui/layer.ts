// Stack of open dialogs / drawers, so Esc closes only the topmost one.
import { useEffect, useRef, type RefObject } from 'react';

const stack: number[] = [];
let nextId = 1;

/** Registers an open layer; `onEscape` runs on Esc when this layer is the topmost. */
export function useLayer(open: boolean, onEscape: () => void): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const id = nextId++;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.stopPropagation();
        cb.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}

/** True while any dialog or drawer is open (pages use it to ignore their own Esc handling). */
export function anyLayerOpen(): boolean {
  return stack.length > 0;
}

/** Focuses the first form control (or the panel) when it opens and restores focus when it closes. */
export function useInitialFocus(open: boolean, panel: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = panel.current;
      if (!el || el.contains(document.activeElement)) return;
      const target = el.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), select, textarea');
      (target ?? el).focus();
    }, 0);
    return () => {
      clearTimeout(t);
      if (before && document.contains(before)) before.focus();
    };
  }, [open, panel]);
}
