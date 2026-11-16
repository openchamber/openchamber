import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightsBlockHtml, highlightsLineHtml, highlightsNow, loadHighlights } from './highlightsEngine';

// Highlighted HTML for code views outside Markdown: whole-block `<pre>` HTML
// and per-line inner HTML, rendered by Highlights on the main thread. A block
// takes about a millisecond per 100 KB, so a view that asks synchronously
// paints highlighted in its first frame.
//
// Results are memoized by content fingerprint and language: unchanged content
// must not be tokenized again on every render (openchamber/openchamber#2769),
// and fingerprints keep large files from being duplicated as cache keys.
// Colors are the `--md-*` CSS variables, so a theme switch repaints through
// CSS and no entry depends on the theme.

// Block HTML and line HTML share one bounded cache, keyed by kind.
type Cached = { block: string } | { lines: string[] };

const results = new HighlightResultCache<Cached>({ maxEntries: 2000, maxBytes: 24 * 1024 * 1024 });

const cacheKey = (kind: 'block' | 'lines', code: string, lang: string): string => `${kind}:${lang}:${contentFingerprint(code)}`;

/**
 * Whole-block `<pre>` HTML, now: null until Highlights has loaded, and for
 * good where it cannot run (the caller keeps plain code).
 */
export const getHighlightedCode = (code: string, lang: string): string | null => {
  const key = cacheKey('block', code, lang);
  const cached = results.get(key);
  if (cached && 'block' in cached) return cached.block;
  const input = highlightsNow(lang, code);
  if (!input) return null;
  const html = highlightsBlockHtml(input);
  results.set(key, { block: html }, utf16Bytes(key) + utf16Bytes(html));
  return html;
};

/**
 * Per-line inner HTML (one entry per source line) from one pass over the
 * whole block, now. Null like `getHighlightedCode`.
 */
export const getHighlightedLines = (code: string, lang: string): string[] | null => {
  const key = cacheKey('lines', code, lang);
  const cached = results.get(key);
  if (cached && 'lines' in cached) return cached.lines;
  const input = highlightsNow(lang, code);
  if (!input) return null;
  const lines = highlightsLineHtml(input);
  let bytes = utf16Bytes(key);
  for (const line of lines) bytes += utf16Bytes(line);
  results.set(key, { lines }, bytes);
  return lines;
};

/** `getHighlightedCode` after the Highlights import has finished. */
export const highlightCode = async (code: string, lang: string): Promise<string | null> => {
  await loadHighlights();
  return getHighlightedCode(code, lang);
};

/** `getHighlightedLines` after the Highlights import has finished. */
export const highlightLines = async (code: string, lang: string): Promise<string[] | null> => {
  await loadHighlights();
  return getHighlightedLines(code, lang);
};
