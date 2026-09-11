/**
 * Regression tests for https://github.com/openchamber/openchamber/issues/2769
 *
 * Sustained Shiki worker CPU came from re-tokenizing unchanged content:
 *  1. `htmlCache` keyed by renderer identity (`simple:${variant}`) so
 *     same-variant instances evicted each other every pass.
 *  2. LRU capped at 240 entries, so long sessions missed 100% on every pass.
 *  3. Worker/client had no result memoization.
 *
 * These tests assert the fixed contracts: content-addressed caching, room for
 * long sessions, bounded LRU behavior, and fingerprint-key helpers.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  contentFingerprint,
  estimateTokenRunsBytes,
  HighlightResultCache,
  utf16Bytes,
} from './highlightResultCache';

let highlightCalls = 0;
let highlightInflight = 0;
let highlightMaxInflight = 0;

const highlightCodeInWorkerMock = mock(async (code: string, lang: string) => {
  highlightCalls += 1;
  highlightInflight += 1;
  highlightMaxInflight = Math.max(highlightMaxInflight, highlightInflight);
  await Promise.resolve();
  highlightInflight -= 1;
  return `<pre data-lang="${lang}"><code>${code}</code></pre>`;
});

mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: highlightCodeInWorkerMock,
  highlightLinesInWorker: mock(async () => null),
  highlightTokensInWorker: mock(async () => null),
  resetMarkdownWorkerClientCacheForTests: mock(() => undefined),
}));

const {
  renderMarkdownBlocks,
  resetMarkdownHtmlCacheForTests,
  __markdownBlockCacheSizesForTests,
} = await import('./markdownCore');

const { resetMarkdownWorkerClientCacheForTests } = await import('./markdown-worker');

beforeEach(() => {
  resetMarkdownHtmlCacheForTests();
  resetMarkdownWorkerClientCacheForTests();
  highlightCalls = 0;
  highlightInflight = 0;
  highlightMaxInflight = 0;
});

describe('HighlightResultCache', () => {
  test('returns cached values for identical keys and refreshes LRU order', () => {
    const cache = new HighlightResultCache<string>({ maxEntries: 2, maxBytes: 10_000 });
    cache.set('a', 'one', utf16Bytes('a') + utf16Bytes('one'));
    cache.set('b', 'two', utf16Bytes('b') + utf16Bytes('two'));
    expect(cache.get('a')).toBe('one');
    // Touch `a` so `b` is oldest; inserting `c` should evict `b`.
    cache.set('c', 'three', utf16Bytes('c') + utf16Bytes('three'));
    expect(cache.get('b')).toEqual(undefined);
    expect(cache.get('a')).toBe('one');
    expect(cache.get('c')).toBe('three');
  });

  test('evicts by byte budget while still caching a single oversized entry', () => {
    const cache = new HighlightResultCache<string>({ maxEntries: 10, maxBytes: 64 });
    cache.set('small', 'x', utf16Bytes('small') + utf16Bytes('x'));
    cache.set('huge', 'y'.repeat(200), utf16Bytes('huge') + utf16Bytes('y'.repeat(200)));
    expect(cache.get('huge')).toBe('y'.repeat(200));
    // Oversized insert cleared prior entries to make room.
    expect(cache.size).toBe(1);
  });

  test('contentFingerprint is stable and length-qualified', () => {
    expect(contentFingerprint('const x = 1')).toBe(contentFingerprint('const x = 1'));
    expect(contentFingerprint('const x = 1')).not.toBe(contentFingerprint('const x = 2'));
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('abc'));
  });

  test('contentFingerprint stays collision-free across a realistic session', () => {
    // A collision here does not mis-color a block — it returns a *different*
    // block's HTML, showing the user source they never wrote. Keep enough key
    // space that a session-sized working set never collides.
    const seen = new Map<string, string>();
    for (let i = 0; i < 20_000; i += 1) {
      // Same-length, near-identical sources are the realistic worst case:
      // repeated tool output differing by a few characters.
      const source = `const value_${String(i).padStart(6, '0')} = ${String(i).padStart(6, '0')};`;
      const fingerprint = contentFingerprint(source);
      expect(seen.get(fingerprint) ?? source).toBe(source);
      seen.set(fingerprint, source);
    }
    expect(seen.size).toBe(20_000);
  });

  test('estimateTokenRunsBytes avoids JSON and stays positive', () => {
    const lines: Array<Array<[number, string, number]>> = [
      [[3, '#fff', 0], [1, '', 1]],
      [[8, 'var(--md-syntax-keyword)', 0]],
    ];
    expect(estimateTokenRunsBytes(lines)).toBeGreaterThan(0);
  });
});

describe('markdownCore content-addressed htmlCache (#2769)', () => {
  test('repeat renders of unchanged content never re-enter the worker', async () => {
    const toolOutputA = '```ts\nconst a = 1;\n```';
    const toolOutputB = '```ts\nconst b = 2;\n```';

    // First pass: cold miss for each distinct block.
    await renderMarkdownBlocks(toolOutputA, false);
    await renderMarkdownBlocks(toolOutputB, false);
    const coldCalls = highlightCalls;
    expect(coldCalls).toBeGreaterThan(0);

    // 100 more passes. Renderers used to pass a shared `simple:${variant}`
    // identity key here and evict each other every pass; lookup is now
    // content-addressed, so no additional worker calls may happen.
    for (let pass = 0; pass < 100; pass += 1) {
      await renderMarkdownBlocks(toolOutputA, false);
      await renderMarkdownBlocks(toolOutputB, false);
    }

    expect(highlightCalls).toBe(coldCalls);
  });

  test('long sessions (working set > former 240 cap) stay warm across re-render passes', async () => {
    const parts = Array.from({ length: 600 }, (_, i) => ({
      content: `\`\`\`ts\nconst value_${i} = ${i};\n\`\`\``,
    }));

    for (const part of parts) {
      await renderMarkdownBlocks(part.content, false);
    }
    const afterCold = highlightCalls;
    expect(afterCold).toBe(parts.length);

    for (let pass = 0; pass < 5; pass += 1) {
      for (const part of parts) {
        await renderMarkdownBlocks(part.content, false);
      }
    }

    // Unchanged content must not re-enter the worker.
    expect(highlightCalls).toBe(afterCold);
  });

  test('content changes invalidate only the changed block', async () => {
    const stable = '```ts\nconst stable = true;\n```';
    const changing = '```ts\nconst n = 1;\n```';

    await renderMarkdownBlocks(stable, false);
    await renderMarkdownBlocks(changing, false);
    const afterFirst = highlightCalls;

    await renderMarkdownBlocks(stable, false);
    await renderMarkdownBlocks('```ts\nconst n = 2;\n```', false);
    expect(highlightCalls).toBe(afterFirst + 1);

    await renderMarkdownBlocks(stable, false);
    expect(highlightCalls).toBe(afterFirst + 1);
  });

  test('image mode is part of the cache identity, not shared across modes', async () => {
    const source = '![diagram](https://example.com/a.png)';

    const [inline] = await renderMarkdownBlocks(source, false, 'inline');
    expect(__markdownBlockCacheSizesForTests().full).toBe(1);

    // Same source, different rendering: content addressing must not let the
    // first-rendered mode answer for both.
    const [label] = await renderMarkdownBlocks(source, false, 'label');
    expect(inline?.id).not.toBe(label?.id);
    expect(__markdownBlockCacheSizesForTests().full).toBe(2);

    // Re-rendering a mode already seen stays a cache hit.
    const [inlineAgain] = await renderMarkdownBlocks(source, false, 'inline');
    expect(inlineAgain?.id).toBe(inline?.id);
    expect(__markdownBlockCacheSizesForTests().full).toBe(2);
  });

  test('streaming a message does not evict settled blocks (live cache is separate)', async () => {
    const settled = Array.from(
      { length: 40 },
      (_, i) => `\`\`\`ts\nconst settled_${i} = ${i};\n\`\`\``,
    );
    for (const block of settled) {
      await renderMarkdownBlocks(block, false);
    }
    const settledEntries = __markdownBlockCacheSizesForTests().full;
    expect(settledEntries).toBe(settled.length);
    const afterSettled = highlightCalls;

    // Stream a message: every step is new content for the trailing live block,
    // so a single shared content-addressed cache would insert one entry per
    // step and evict the settled working set this fix exists to keep warm.
    let streamed = '';
    for (let step = 0; step < 150; step += 1) {
      streamed += `word_${step} `;
      await renderMarkdownBlocks(streamed, true);
    }

    const sizes = __markdownBlockCacheSizesForTests();
    expect(sizes.live).toBeLessThanOrEqual(32);
    expect(sizes.full).toBe(settledEntries);

    for (const block of settled) {
      await renderMarkdownBlocks(block, false);
    }
    expect(highlightCalls).toBe(afterSettled);
  });

  test('a repeated streaming step is served from the live cache', async () => {
    const step = 'partial answer text';
    const [first] = await renderMarkdownBlocks(step, true);
    const [second] = await renderMarkdownBlocks(step, true);

    expect(second?.id).toBe(first?.id);
    expect(__markdownBlockCacheSizesForTests()).toEqual({ full: 0, live: 1 });
  });

  test('multiple code fences in one document highlight concurrently', async () => {
    const multi = [
      '```ts\nconst a = 1;\n```',
      '',
      '```ts\nconst b = 2;\n```',
      '',
      '```ts\nconst c = 3;\n```',
    ].join('\n');

    await renderMarkdownBlocks(multi, false);
    expect(highlightCalls).toBe(3);
    // Sequential awaits would keep max inflight at 1.
    expect(highlightMaxInflight).toBeGreaterThan(1);
  });
});
