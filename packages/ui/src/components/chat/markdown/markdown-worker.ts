import MarkdownShikiWorkerUrl from './markdown-shiki.worker.ts?worker&url';
import type { MarkdownTokenRun, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';
import { HIGHLIGHT_REQUEST_TIMEOUT_MS } from './markdown-worker-timeout';

export { HIGHLIGHT_REQUEST_TIMEOUT_MS } from './markdown-worker-timeout';

// Main-thread client for the markdown Shiki Web Worker. Moves syntax tokenization
// off the UI thread: a closed code block is shipped to the worker, which returns
// ready-to-splice Shiki HTML. On any failure (no worker support, worker crash,
// tokenization error, or hang timeout) the promise resolves to `null` and the
// caller keeps the escaped plain-text code — highlighting never falls back onto
// the main thread.
//
// The timeout exists because TextMate grammars can enter catastrophic backtracking
// on the Oniguruma WASM engine (openchamber/openchamber#2587). Matching is sync
// inside the worker, so the only way to reclaim memory is to terminate it from
// this thread when a request exceeds the budget.

type PendingResolver = (response: MarkdownWorkerResponse | null) => void;

type PendingEntry = {
  resolve: PendingResolver;
  timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, PendingEntry>();
// Theme names whose full definition we've already shipped to the live worker, so
// repeat tokenization sends only the name (not the whole theme object) again.
const sentThemes = new Set<string>();

const clearPendingTimers = (): void => {
  pending.forEach((entry) => clearTimeout(entry.timer));
};

const failAll = (): void => {
  clearPendingTimers();
  pending.forEach((entry) => entry.resolve(null));
  pending.clear();
  sentThemes.clear();
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
    const entry = pending.get(event.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(event.data.id);
    entry.resolve(event.data);
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
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // Hung tokenize (e.g. catastrophic backtracking): kill the worker so the
      // WASM heap is freed instead of growing until the renderer OOMs.
      console.warn(`Shiki worker highlight timed out after ${HIGHLIGHT_REQUEST_TIMEOUT_MS}ms; terminating worker`);
      failAll();
    }, HIGHLIGHT_REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    instance.postMessage(payload(id));
  });
};

/**
 * Highlight a complete code block in the worker. Resolves to Shiki `<pre>` HTML,
 * or `null` if highlighting is unavailable or failed (caller keeps plain code).
 */
export const highlightCodeInWorker = async (code: string, lang: string): Promise<string | null> => {
  const response = await request((id) => ({ type: 'highlight', id, code, lang }));
  return response?.type === 'highlight' ? response.html : null;
};

/**
 * Highlight a whole block and return per-line inner HTML (one entry per source
 * line). For per-line layouts (diffs, gutters, virtualization) — one worker
 * round-trip instead of one per line. Resolves to `null` on failure.
 */
export const highlightLinesInWorker = async (code: string, lang: string): Promise<string[] | null> => {
  const response = await request((id) => ({ type: 'highlightLines', id, code, lang }));
  return response?.type === 'highlightLines' ? response.lines : null;
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
  const needsTheme = !sentThemes.has(themeName);
  const response = await request((id) => ({
    type: 'highlightTokens',
    id,
    code,
    lang,
    themeName,
    ...(needsTheme ? { theme } : {}),
  }));
  if (response?.type === 'highlightTokens') {
    sentThemes.add(themeName);
    return response.lines;
  }
  return null;
};
