// The look of the office pages: "jiangshan" (the blue-green landscape palette of the Song painting
// "A Thousand Li of Rivers and Mountains": azurite, malachite, ochre on silk) or "saas" (the neutral one).
// Kept in this browser (localStorage 'wms.style'); tokens.css reads <html data-style>. The driver app keeps
// its own high-contrast theme in both.
export type Look = 'jiangshan' | 'saas';
export const LOOKS: Look[] = ['jiangshan', 'saas'];
const KEY = 'wms.style';

export function getLook(): Look {
  try {
    return localStorage.getItem(KEY) === 'saas' ? 'saas' : 'jiangshan';
  } catch {
    return 'jiangshan';
  }
}

export function setLook(look: Look): void {
  document.documentElement.dataset.style = look;
  try {
    localStorage.setItem(KEY, look);
  } catch {
    // private window: the look lasts until the page reloads
  }
}
