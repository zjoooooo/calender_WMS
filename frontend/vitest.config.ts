// Unit tests (§13): plain logic tests in a Node environment. Add `environment: 'jsdom'` per file
// (// @vitest-environment jsdom) if a test needs the DOM, after adding jsdom to devDependencies.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
