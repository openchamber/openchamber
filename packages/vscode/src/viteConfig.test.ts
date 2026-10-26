import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

describe('VS Code webview worker build', () => {
  test('bundles worker imports into one file', () => {
    assert.match(source, /worker:\s*\{[\s\S]*?inlineDynamicImports:\s*true/);
  });
});
