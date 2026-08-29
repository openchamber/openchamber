import MarkdownShikiWorkerUrl from './markdown-shiki.worker.ts?worker&url';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import {
  contentFingerprint,
  estimateTokenRunsBytes,
  HighlightResultCache,
  utf16Bytes,
} from './highlightResultCache';
import type { MarkdownTokenRun, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';
import { HIGHLIGHT_REQUEST_TIMEOUT_MS } from './markdown-worker-timeout';

// Main-thread client for the markdown Shiki Web Worker. Moves syntax tokenization
// off the UI thread: a closed code block is shipped to the worker, which returns
// ready-to-splice Shiki HTML. On any failure (no worker support, worker crash,
// tokenization error, or hang timeout) the promise resolves to `null` and the
// caller keeps the escaped plain-text code — highlighting never falls back onto
// the main thread.
//
// The per-request timeout exists because TextMate grammars can enter catastrophic
// backtracking on the Oniguruma WASM engine (openchamber/openchamber#2587).
// Matching is synchronous inside the worker, so the only way to reclaim its heap
// is to terminate it from this thread once a request exceeds the budget.
//
// A timeout is scoped to the block that caused it: only that request resolves
// `null`, and the requests that were merely queued behind it are re-dispatched
// against the fresh worker. The timed-out key is memoized as failed, because a
// block that hangs the grammar hangs it every time — without that, every
// re-render and every scroll past the block would pay another worker spawn
// (Shiki + Oniguruma init) plus the full timeout budget of a core.
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

/**
 * Why a request stopped, kept distinct so a hang can be memoized while a
 * transient "no worker yet" failure is retried on the next render.
 */
type RequestOutcome =
  | { status: 'ok'; response: MarkdownWorkerResponse }
  | { status: 'failed' }
  | { status: 'timeout' };

type PendingResolver = (outcome: RequestOutcome) => void;

type PendingEntry = {
  resolve: PendingResolver;
  timer: ReturnType<typeof setTimeout>;
  payload: MarkdownWorkerRequest;
};

type CachedHighlight =
  | { type: 'highlight'; html: string }
  | { type: 'highlightLines'; lines: string[] }
  | { type: 'highlightTokens'; lines: MarkdownTokenRun[][] }
  // A block that timed out the worker. Memoized so it is attempted once per
  // session instead of respawning a worker on every render.
  | { type: 'failed' };

const CLIENT_CACHE_MAX_ENTRIES = 2000;
const CLIENT_CACHE_MAX_BYTES = 24 * 1024 * 1024;

const resultCache = new HighlightResultCache<CachedHighlight>({
  maxEntries: CLIENT_CACHE_MAX_ENTRIES,
  maxBytes: CLIENT_CACHE_MAX_BYTES,
});

const inflight = new Map<string, Promise<CachedHighlight | null>>();

let worker: Worker | undefined;
let workerCreation: Promise<Worker | undefined> | undefined;
let workerObjectUrl: string | undefined;
let nextId = 0;
const pending = new Map<number, PendingEntry>();
// Theme names whose full definition we've already shipped to the live worker, so
// repeat tokenization sends only the name (not the whole theme object) again.
const sentThemes = new Set<string>();

const clearPendingTimers = (): void => {
  pending.forEach((entry) => clearTimeout(entry.timer));
};

const entryBytes = (key: string, value: CachedHighlight): number => {
  const keyBytes = utf16Bytes(key);
  if (value.type === 'failed') return keyBytes;
  if (value.type === 'highlight') return keyBytes + utf16Bytes(value.html);
  if (value.type === 'highlightLines') {
    let total = keyBytes;
    for (const line of value.lines) total += utf16Bytes(line);
    return total;
  }
  return keyBytes + estimateTokenRunsBytes(value.lines);
};

const disposeWorker = (): void => {
  sentThemes.clear();
  worker?.terminate();
  worker = undefined;
  workerCreation = undefined;
  if (workerObjectUrl) {
    URL.revokeObjectURL(workerObjectUrl);
    workerObjectUrl = undefined;
  }
};

/** Worker crash / message error: nothing in flight can still be answered. */
const failAll = (): void => {
  clearPendingTimers();
  pending.forEach((entry) => entry.resolve({ status: 'failed' }));
  pending.clear();
  // Drop in-flight waiters; cached results remain valid (pure fn of inputs).
  inflight.clear();
  disposeWorker();
};

const createWorker = async (): Promise<Worker | undefined> => {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return undefined;
  try {
    let workerUrl = MarkdownShikiWorkerUrl;
    if (isVSCodeRuntime(null)) {
      const response = await fetch(workerUrl);
      if (!response.ok) throw new Error(`Shiki worker request failed with ${response.status}`);
      workerObjectUrl = URL.createObjectURL(await response.blob());
      workerUrl = workerObjectUrl;
    }

    const instance = new Worker(workerUrl, { type: 'module' });
    worker = instance;
    instance.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(event.data.id);
      entry.resolve({ status: 'ok', response: event.data });
    };
    instance.onerror = failAll;
    instance.onmessageerror = failAll;
    instance.postMessage({ type: 'init' } satisfies MarkdownWorkerRequest);
    return instance;
  } catch (err) {
    if (workerObjectUrl) {
      URL.revokeObjectURL(workerObjectUrl);
      workerObjectUrl = undefined;
    }
    console.error('Failed to create Shiki worker:', err);
    return undefined;
  }
};

const getWorker = async (): Promise<Worker | undefined> => {
  if (worker) return worker;
  workerCreation ??= createWorker().finally(() => {
    workerCreation = undefined;
  });
  return workerCreation;
};

/**
 * Post one request and arm its timeout. The timer starts here, not when the
 * caller enqueued, so a request re-dispatched after someone else's hang gets a
 * whole budget on the fresh worker rather than an already-spent one.
 */
const dispatch = async (id: number, resolve: PendingResolver, payload: MarkdownWorkerRequest): Promise<void> => {
  const instance = await getWorker();
  if (!instance) {
    resolve({ status: 'failed' });
    return;
  }
  const timer = setTimeout(() => handleTimeout(id), HIGHLIGHT_REQUEST_TIMEOUT_MS);
  pending.set(id, { resolve, timer, payload });
  instance.postMessage(payload);
};

/**
 * One request exceeded the budget. Kill the worker so the WASM heap is freed
 * instead of growing until the renderer OOMs, fail only the offending request,
 * and replay the requests that were only waiting behind it.
 */
function handleTimeout(id: number): void {
  const offender = pending.get(id);
  if (!offender) return;
  console.warn(`Shiki worker highlight timed out after ${HIGHLIGHT_REQUEST_TIMEOUT_MS}ms; terminating worker`);

  const survivors = Array.from(pending.entries()).filter(([pendingId]) => pendingId !== id);
  clearPendingTimers();
  pending.clear();
  disposeWorker();

  offender.resolve({ status: 'timeout' });

  for (const [survivorId, entry] of survivors) {
    // A `highlightTokens` payload whose theme was already shipped to the dead
    // worker cannot be replayed — the definition went with it, and the fresh
    // worker would reject the bare theme name.
    if (entry.payload.type === 'highlightTokens' && entry.payload.theme === undefined) {
      entry.resolve({ status: 'failed' });
      continue;
    }
    void dispatch(survivorId, entry.resolve, entry.payload);
  }
}

const request = async (payload: (id: number) => MarkdownWorkerRequest): Promise<RequestOutcome> => {
  const id = ++nextId;
  const message = payload(id);
  return new Promise<RequestOutcome>((resolve) => {
    void dispatch(id, resolve, message);
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

const memoizeFailure = (key: string): CachedHighlight => {
  const entry: CachedHighlight = { type: 'failed' };
  resultCache.set(key, entry, entryBytes(key, entry));
  return entry;
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
  if (cached?.type === 'failed') return null;

  const result = await coalesce(key, async () => {
    const outcome = await request((id) => ({ type: 'highlight', id, code, lang }));
    if (outcome.status === 'timeout') return memoizeFailure(key);
    if (outcome.status !== 'ok' || outcome.response.type !== 'highlight') return null;
    const entry: CachedHighlight = { type: 'highlight', html: outcome.response.html };
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
  if (cached?.type === 'failed') return null;

  const result = await coalesce(key, async () => {
    const outcome = await request((id) => ({ type: 'highlightLines', id, code, lang }));
    if (outcome.status === 'timeout') return memoizeFailure(key);
    if (outcome.status !== 'ok' || outcome.response.type !== 'highlightLines') return null;
    const entry: CachedHighlight = { type: 'highlightLines', lines: outcome.response.lines };
    resultCache.set(key, entry, entryBytes(key, entry));
    return entry;
  });
  return result?.type === 'highlightLines' ? result.lines : null;
};

/** Return an already-tokenized line result without scheduling a worker request. */
export const getCachedHighlightedLines = (code: string, lang: string): string[] | null => {
  const cached = resultCache.get(cacheKeyFor('highlightLines', lang, code));
  return cached?.type === 'highlightLines' ? cached.lines : null;
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
  if (cached?.type === 'failed') return null;

  const result = await coalesce(key, async () => {
    const needsTheme = !sentThemes.has(themeName);
    const outcome = await request((id) => ({
      type: 'highlightTokens',
      id,
      code,
      lang,
      themeName,
      ...(needsTheme ? { theme } : {}),
    }));
    if (outcome.status === 'timeout') return memoizeFailure(key);
    if (outcome.status !== 'ok' || outcome.response.type !== 'highlightTokens') return null;
    sentThemes.add(themeName);
    const entry: CachedHighlight = { type: 'highlightTokens', lines: outcome.response.lines };
    resultCache.set(key, entry, entryBytes(key, entry));
    return entry;
  });
  return result?.type === 'highlightTokens' ? result.lines : null;
};
