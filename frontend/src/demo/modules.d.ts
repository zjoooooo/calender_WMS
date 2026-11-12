// Types of the demo build's own modules (§11.5).

/** PHP 8.3 for the web (php-wasm). The package ships JavaScript only; these are the two functions used. */
declare module '@php-wasm/web-8-3' {
  import type { PHPLoaderModule } from '@php-wasm/universal';
  /** The JSPI build where the browser supports JSPI, the Asyncify build otherwise. */
  export function getPHPLoaderModule(): Promise<PHPLoaderModule>;
  export function jspi(): Promise<boolean>;
}

/** Made by vite.demo.ts: the URL of the JSON with the backend's PHP files and the demo data. */
declare module 'virtual:wms-demo-bundle' {
  export const bundleUrl: string;
  export const bundleMeta: { version: string; size: number };
}
