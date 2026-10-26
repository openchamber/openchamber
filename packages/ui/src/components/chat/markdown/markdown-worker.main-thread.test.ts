import { expect, test } from 'bun:test';
import { plugin } from 'bun';

// Bun does not implement Vite's worker asset-query imports; no worker is
// needed for Highlights languages.
plugin({
  name: 'markdown-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
  },
});

const { getCachedHighlightedCode, getCachedHighlightedLines, highlightLinesInWorker } = await import('./markdown-worker');
const { loadHighlights } = await import('./highlightsEngine');

test('Highlights languages are ready synchronously once the module has loaded', async () => {
  expect(getCachedHighlightedLines('const a = 1;', 'typescript')).toBeNull();
  const lines = await highlightLinesInWorker('x = 1\n# note', 'python');
  expect(lines).toHaveLength(2);
  expect(lines?.[1]).toBe('<span style="color:var(--md-syntax-comment)"># note</span>');
  await loadHighlights();
  expect(getCachedHighlightedLines('const a = 1;', 'typescript')?.[0]).toContain('var(--md-token-storageModifier)');
  expect(getCachedHighlightedCode('const a = 1;', 'typescript')?.startsWith('<pre class="highlights"')).toBe(true);
  // Shiki languages still need the worker.
  expect(getCachedHighlightedLines('a = 1', 'coffee')).toBeNull();
});
