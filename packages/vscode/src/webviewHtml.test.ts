import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('./webviewHtml.ts', import.meta.url), 'utf8');

describe('VS Code webview content security policy', () => {
  test('allows blob URLs for workers without allowing blob scripts', () => {
    const workerSource = source.match(/const workerSrc = ([^\n]+);/)?.[1] ?? '';
    const scriptSource = source.match(/const scriptSrc = ([^\n]+);/)?.[1] ?? '';

    assert.match(workerSource, /'blob:'/);
    assert.doesNotMatch(scriptSource, /'blob:'/);
    assert.match(source, /worker-src \$\{workerSrc\}/);
  });

  test('allows bundled notification sounds via media-src only', () => {
    const mediaSource = source.match(/const mediaSrc = ([^\n]+);/)?.[1] ?? '';
    const scriptSource = source.match(/const scriptSrc = ([^\n]+);/)?.[1] ?? '';

    // The 4 KB-and-under clips are inlined by the Vite build as data: URIs.
    assert.match(mediaSource, /'data:'/);
    assert.match(source, /media-src \$\{mediaSrc\}/);
    // media-src must not become a back door into script or style execution.
    assert.doesNotMatch(scriptSource, /'data:'/);
    assert.doesNotMatch(source.match(/const styleSrc = ([^\n]+);/)?.[1] ?? '', /'data:'/);
  });
});
