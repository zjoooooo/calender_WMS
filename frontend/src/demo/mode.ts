// Which demo this page is (demo build only, §11.5). The demo build has two pages on the same static host:
// the office calendar at ./ and the driver app at ./driver/ (driver/index.html, written by vite.demo.ts with
// the marker below). Both run the same backend in the browser and share the visitor's saved copy of the data.
export const DEMO_DRIVER: boolean =
  __WMS_DEMO__ && typeof document !== 'undefined' && document.querySelector('meta[name="wms-page"]')?.getAttribute('content') === 'driver';
