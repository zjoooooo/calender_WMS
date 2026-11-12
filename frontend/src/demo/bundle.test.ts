// The demo bundle's version (vite.demo.ts, §11.5): a visitor's saved copy of the data is kept only while the
// deployed backend code AND data are the same, so the weekly rebuild's new runs reach returning visitors too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeDemoBundle } from '../../vite.demo';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-demo-bundle-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function dataRoot(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo.json'), JSON.stringify({ built_at: '2026-11-16T01:20:00Z', today: '2026-11-16', login: { username: 'admin', password: 'x' } }));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'data', f), text);
  return root;
}

describe('makeDemoBundle version', () => {
  it('is the same for the same backend and data, and changes with the data', () => {
    const a = makeDemoBundle(dataRoot('a', { 'routes.json': '{"routes":[1]}' }));
    const same = makeDemoBundle(dataRoot('same', { 'routes.json': '{"routes":[1]}', '.lock': '' }));
    const newer = makeDemoBundle(dataRoot('newer', { 'routes.json': '{"routes":[1,2]}' }));
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(same.version).toBe(a.version);
    expect(newer.version).not.toBe(a.version);
    expect(Object.keys(a.data)).toEqual(['routes.json']);
    expect(a.backend['public/index.php']).toBeTruthy();
  });
});
