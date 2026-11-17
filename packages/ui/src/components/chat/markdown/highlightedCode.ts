import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightsBlockHtml, highlightsLineHtml, highlightsNow, loadHighlights } from './highlightsEngine';


type Cached = { block: string } | { lines: string[] };

const results = new HighlightResultCache<Cached>({ maxEntries: 2000, maxBytes: 24 * 1024 * 1024 });

const cacheKey = (kind: 'block' | 'lines', code: string, lang: string): string => `${kind}:${lang}:${contentFingerprint(code)}`;

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

export const highlightCode = async (code: string, lang: string): Promise<string | null> => {
  await loadHighlights();
  return getHighlightedCode(code, lang);
};

export const highlightLines = async (code: string, lang: string): Promise<string[] | null> => {
  await loadHighlights();
  return getHighlightedLines(code, lang);
};
