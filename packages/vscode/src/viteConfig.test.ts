import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import config from '../vite.config';

describe('VS Code webview worker build', () => {
  test('bundles worker imports into one file', () => {
    const output = config({ command: 'build', mode: 'production' }).worker?.rollupOptions?.output;
    assert.ok(output && !Array.isArray(output));
    assert.equal(output.inlineDynamicImports, true);
  });
});
