import MarkdownShikiWorkerUrl from './markdown-shiki.worker.ts?worker&url';
import {
  contentFingerprint,
  estimateTokenRunsBytes,
  HighlightResultCache,
  utf16Bytes,
} from './highlightResultCache';
import type { MarkdownTokenRun, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';

// Main-thread client for the markdown Shiki worker. Moves syntax tokenization
// off the UI thread: a closed code block is shipped to the worker, which returns
// ready-to-splice Shiki HTML. On any failure (no worker support, worker crash,
// tokenization error) the promise resolves to `null` and the caller keeps the
// escaped plain-text code — highlighting never falls back onto the main thread.
//
// Results are memoized by content fingerprint (+ lang / theme). Unchanged
// content must not re-enter the worker — that was the sustained ~40 msg/s
// re-highlight load in openchamber/openchamber#2769. In-flight requests with
// the same key coalesce so remount storms share one round-trip. Cache keys are
// fingerprints (not full source) so large files are not duplicated in the Map.
//
// This module is the only sender to the worker, so memoizing here is sufficient
// and the worker itself stays stateless apart from the Shiki instance. A second
// cache inside the worker would only duplicate these payloads in another heap.
//
// `highlight` / `highlightLines` results are theme-independent: the worker
// tokenizes with the CSS-variable `MARKDOWN_SHIKI_THEME`, so a theme switch
// repaints via CSS and must not invalidate these entries. Only
// `highlightTokens` resolves concrete colors, so only its key carries a theme.

type PendingResolver = (response: MarkdownWorkerResponse | null) => void;

type CachedHighlight =
  | { type: 'highlight'; html: string }
  | { type: 'highlightLines'; lines: string[] }
  | { type: 'highlightTokens'; lines: MarkdownTokenRun[][] };

const CLIENT_CACHE_MAX_ENTRIES = 2000;
const CLIENT_CACHE_MAX_BYTES = 24 * 1024 * 1024;

const resultCache = new HighlightResultCache<CachedHighlight>({
  maxEntries: CLIENT_CACHE_MAX_ENTRIES,
  maxBytes: CLIENT_CACHE_MAX_BYTES,
});

const inflight = new Map<string, Promise<CachedHighlight | null>>();

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, PendingResolver>();
// Theme names whose full definition we've already shipped to the live worker, so
// repeat tokenization sends only the name (not the whole theme object) again.
const sentThemes = new Set<string>();

const entryBytes = (key: string, value: CachedHighlight): number => {
  const keyBytes = utf16Bytes(key);
  if (value.type === 'highlight') return keyBytes + utf16Bytes(value.html);
  if (value.type === 'highlightLines') {
    let total = keyBytes;
    for (const line of value.lines) total += utf16Bytes(line);
    return total;
  }
  return keyBytes + estimateTokenRunsBytes(value.lines);
};

const failAll = (): void => {
  pending.forEach((resolve) => resolve(null));
  pending.clear();
  sentThemes.clear();
  // Drop in-flight waiters; cached results remain valid (pure fn of inputs).
  inflight.clear();
  worker?.terminate();
  worker = undefined;
};

const getWorker = (): Worker | undefined => {
  if (worker) return worker;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return undefined;
  try {
    worker = new Worker(MarkdownShikiWorkerUrl, { type: 'module' });
  } catch (err) {
    console.error('Failed to create Shiki worker:', err);
    return undefined;
  }
  worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  };
  worker.onerror = failAll;
  worker.onmessageerror = failAll;
  worker.postMessage({ type: 'init' } satisfies MarkdownWorkerRequest);
  return worker;
};

const request = (payload: (id: number) => MarkdownWorkerRequest): Promise<MarkdownWorkerResponse | null> => {
  const instance = getWorker();
  if (!instance) return Promise.resolve(null);
  const id = ++nextId;
  return new Promise<MarkdownWorkerResponse | null>((resolve) => {
    pending.set(id, resolve);
    instance.postMessage(payload(id));
  });
};

const coalesce = (
  key: string,
  run: () => Promise<CachedHighlight | null>,
): Promise<CachedHighlight | null> => {
  const existing = inflight.get(key);
  if (existing) return existing;
  const pendingRequest = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pendingRequest);
  return pendingRequest;
};

const cacheKeyFor = (kind: string, lang: string, code: string, themeName?: string): string => {
  const fp = contentFingerprint(code);
  return themeName === undefined ? `${kind}:${lang}:${fp}` : `${kind}:${themeName}:${lang}:${fp}`;
};

/** Test-only: clear client-side highlight memoization. */
export const resetMarkdownWorkerClientCacheForTests = (): void => {
  resultCache.clear();
  inflight.clear();
};

/**
 * Highlight a complete code block in the worker. Resolves to Shiki `<pre>` HTML,
 * or `null` if highlighting is unavailable or failed (caller keeps plain code).
 */
export const highlightCodeInWorker = async (code: string, lang: string): Promise<string | null> => {
  const key = cacheKeyFor('highlight', lang, code);
  const cached = resultCache.get(key);
  if (cached?.type === 'highlight') return cached.html;

  const result = await coalesce(key, async () => {
    const response = await request((id) => ({ type: 'highlight', id, code, lang }));
    if (response?.type !== 'highlight') return null;
    const entry: CachedHighlight = { type: 'highlight', html: response.html };
    resultCache.set(key, entry, entryBytes(key, entry));
    return entry;
  });
  return result?.type === 'highlight' ? result.html : null;
};

/**
 * Highlight a whole block and return per-line inner HTML (one entry per source
 * line). For per-line layouts (diffs, gutters, virtualization) — one worker
 * round-trip instead of one per line. Resolves to `null` on failure.
 */
export const highlightLinesInWorker = async (code: string, lang: string): Promise<string[] | null> => {
  const key = cacheKeyFor('highlightLines', lang, code);
  const cached = resultCache.get(key);
  if (cached?.type === 'highlightLines') return cached.lines;

  const result = await coalesce(key, async () => {
    const response = await request((id) => ({ type: 'highlightLines', id, code, lang }));
    if (response?.type !== 'highlightLines') return null;
    const entry: CachedHighlight = { type: 'highlightLines', lines: response.lines };
    resultCache.set(key, entry, entryBytes(key, entry));
    return entry;
  });
  return result?.type === 'highlightLines' ? result.lines : null;
};

/**
 * Tokenize `code` with the given resolved TextMate theme and return per-line
 * styled runs with offsets — for building CodeMirror decorations that match the
 * Shiki file view exactly. The full theme object is shipped only the first time
 * a theme name is seen by the live worker. Resolves to `null` on failure.
 */
export const highlightTokensInWorker = async (
  code: string,
  lang: string,
  themeName: string,
  theme: unknown,
): Promise<MarkdownTokenRun[][] | null> => {
  const key = cacheKeyFor('highlightTokens', lang, code, themeName);
  const cached = resultCache.get(key);
  if (cached?.type === 'highlightTokens') return cached.lines;

  const result = await coalesce(key, async () => {
    const needsTheme = !sentThemes.has(themeName);
    const response = await request((id) => ({
      type: 'highlightTokens',
      id,
      code,
      lang,
      themeName,
      ...(needsTheme ? { theme } : {}),
    }));
    if (response?.type !== 'highlightTokens') return null;
    sentThemes.add(themeName);
    const entry: CachedHighlight = { type: 'highlightTokens', lines: response.lines };
    resultCache.set(key, entry, entryBytes(key, entry));
    return entry;
  });
  return result?.type === 'highlightTokens' ? result.lines : null;
};
