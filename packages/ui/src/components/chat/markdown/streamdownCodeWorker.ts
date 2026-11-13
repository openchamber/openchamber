import type { HighlightResult } from 'streamdown';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { streamTuning } from '../lib/streamTuningFlags';
import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { HIGHLIGHT_REQUEST_TIMEOUT_MS } from './markdown-worker-timeout';
import { highlightsNow, highlightsSettled, highlightsTokens, loadHighlights } from './highlightsEngine';
import { packCodeTokens, unpackCodeTokens } from './streamdown-code-protocol';
import type { StreamdownCodeRequest, StreamdownCodeResponse } from './streamdown-code-protocol';

const cacheKey = (code: string, language: string) => `highlight:${language}:${contentFingerprint(code)}`;
type CachedHighlight = { result: HighlightResult } | { failed: true };
type Snapshot = { code: string; language: string; result: HighlightResult; lineage: number; seq: number };
type Outcome = { status: 'ok'; response: StreamdownCodeResponse } | { status: 'failed' | 'timeout' };
type Job = {
  request: StreamdownCodeRequest;
  resolve: (outcome: Outcome) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type WorkerConnection = { worker: Worker; objectUrl?: string };

function sharedLineCount(base: Pick<Snapshot, 'code' | 'result'>, code: string): number {
  if (code.startsWith(base.code)) return base.result.tokens.length - 1;
  const end = Math.min(base.code.length, code.length);
  let index = 0;
  let lines = 0;
  while (index < end && base.code.charCodeAt(index) === code.charCodeAt(index)) {
    if (code[index] === '\n') lines++;
    index++;
  }
  return lines;
}

type Row = HighlightResult['tokens'][number];

const sameRow = (a: Row, b: Row): boolean => a.length === b.length && a.every((token, index) => {
  const other = b[index];
  return token.content === other.content && token.offset === other.offset && token.color === other.color
    && token.bgColor === other.bgColor && JSON.stringify(token.htmlStyle) === JSON.stringify(other.htmlStyle);
});

/**
 * Languages with a Highlights lexer tokenize on the main thread, synchronously,
 * so a block paints highlighted in its first frame: Highlights takes about a
 * millisecond per 100 KB. Other languages go to the Shiki worker with the
 * pre-migration cache and timeout policy. Both return React tokens.
 */
export class StreamdownCodeWorker {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private creation: Promise<Worker | null> | null = null;
  private loading: AbortController | null = null;
  private pending = new Map<number, Job>();
  private inflight = new Map<string, Promise<HighlightResult | null>>();
  private completed = new HighlightResultCache<CachedHighlight>({ maxEntries: 2000, maxBytes: 24 * 1024 * 1024 });
  private recent: Array<{ key: string; result: HighlightResult }> = [];
  private snapshots: Snapshot[] = [];
  private disposed = false;
  private sequence = 0;
  private lineage = 0;
  private mainThreadPrevious: Array<{ code: string; language: string; result: HighlightResult }> = [];

  constructor() {
    void loadHighlights();
  }

  cached(code: string, language: string, isIncomplete = false): HighlightResult | undefined {
    const key = cacheKey(code, language);
    const settled = this.completed.get(key);
    if (settled) return 'result' in settled ? settled.result : undefined;
    const recent = this.recent.find((entry) => entry.key === key)?.result;
    if (recent && !isIncomplete) this.remember(key, recent);
    return recent ?? this.highlightOnMainThread(key, code, language, isIncomplete);
  }

  private highlightOnMainThread(key: string, code: string, language: string, isIncomplete: boolean): HighlightResult | undefined {
    const target = highlightsNow(language);
    if (!target || this.disposed) return undefined;
    const result = unpackCodeTokens(code, packCodeTokens(highlightsTokens(target, code)));
    // A streaming block grows by appended lines; rows that did not change keep
    // their identity so React skips them, as with the worker's prefix reuse.
    let base: { code: string; result: HighlightResult } | undefined;
    let shared = 0;
    for (const candidate of this.mainThreadPrevious) {
      if (candidate.language !== language) continue;
      const count = sharedLineCount(candidate, code);
      if (count > shared) { shared = count; base = candidate; }
    }
    for (let line = 0; base && line < shared; line++) {
      if (sameRow(base.result.tokens[line], result.tokens[line])) result.tokens[line] = base.result.tokens[line];
    }
    this.mainThreadPrevious = [{ code, language, result }, ...this.mainThreadPrevious.filter((entry) => entry !== base)].slice(0, 4);
    if (isIncomplete) {
      this.recent = [{ key, result }, ...this.recent.filter((entry) => entry.key !== key)].slice(0, 4);
    } else this.remember(key, result);
    return result;
  }

  private remember(key: string, result: HighlightResult): void {
    // Account once on insertion. The shared LRU permits one oversized entry,
    // just as it does for the old HTML payload; token objects replace HTML here.
    let bytes = utf16Bytes(key);
    for (const line of result.tokens) {
      bytes += 32;
      for (const token of line) {
        bytes += 160 + utf16Bytes(token.content) + utf16Bytes(token.color ?? '') + utf16Bytes(token.bgColor ?? '');
      }
    }
    this.completed.set(key, { result }, bytes);
  }

  highlight(code: string, language: string, isIncomplete: boolean): Promise<HighlightResult | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = cacheKey(code, language);
    const cached = this.cached(code, language, isIncomplete);
    if (cached) return Promise.resolve(cached);
    // Only the first blocks wait for the import; afterwards the worker call is
    // direct, so identical requests keep coalescing into one promise.
    if (highlightsSettled()) return this.highlightInWorker(key, code, language, isIncomplete);
    return loadHighlights().then(() => this.cached(code, language, isIncomplete) ?? this.highlightInWorker(key, code, language, isIncomplete));
  }

  private highlightInWorker(key: string, code: string, language: string, isIncomplete: boolean): Promise<HighlightResult | null> {
    if (this.disposed) return Promise.resolve(null);
    const entry = this.completed.get(key);
    if (entry && 'failed' in entry) return Promise.resolve(null);
    // Streaming steps retain only recent results. Only completed requests
    // coalesce, matching the original client while a fence is still changing.
    if (isIncomplete) return this.highlightSource(key, code, language, true).catch(() => null);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.highlightSource(key, code, language, false).catch(() => null).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async highlightSource(key: string, code: string, language: string, isIncomplete: boolean): Promise<HighlightResult | null> {
    const incremental = streamTuning.incrementalHighlight();
    const resumable = isIncomplete && incremental && code.length <= 256 * 1024 && !code.includes('\r');
    let base: Snapshot | undefined;
    let shared = 0;
    if (resumable) {
      for (const candidate of this.snapshots) {
        if (candidate.language !== language) continue;
        const count = sharedLineCount(candidate, code);
        if (count > shared) { shared = count; base = candidate; }
      }
    }
    const id = ++this.sequence;
    const request: StreamdownCodeRequest = {
      id, code, language, fullPass: !incremental,
    };
    if (resumable) request.fromLine = shared;
    let outcome = await this.request(request);
    if (this.disposed) return null;
    if (outcome.status === 'timeout') this.completed.set(key, { failed: true }, utf16Bytes(key));
    if (outcome.status !== 'ok' || 'error' in outcome.response) return null;
    let result = unpackCodeTokens(code, outcome.response.result);
    if (base) result.tokens = base.result.tokens.slice(0, shared).concat(result.tokens);
    if (result.tokens.length !== code.split(/\r\n|\n|\r/).length) {
      if (!resumable) return null;
      // A mismatched suffix cannot be spliced. Retry the whole block once with
      // a fresh request deadline, as the old highlightFrom path did.
      outcome = await this.request({ id: ++this.sequence, code, language, fullPass: !incremental });
      if (this.disposed) return null;
      if (outcome.status === 'timeout') this.completed.set(key, { failed: true }, utf16Bytes(key));
      if (outcome.status !== 'ok' || 'error' in outcome.response) return null;
      result = unpackCodeTokens(code, outcome.response.result);
      if (result.tokens.length !== code.split(/\r\n|\n|\r/).length) return null;
    } else if (resumable) {
      const lineage = base?.lineage ?? this.lineage++;
      const current = this.snapshots.find((entry) => entry.lineage === lineage);
      if (!current || current.seq < id) {
        this.snapshots = [{ code, language, result, lineage, seq: id },
          ...this.snapshots.filter((entry) => entry.lineage !== lineage)].slice(0, 4);
      }
    }
    if (isIncomplete) {
      this.recent = [{ key, result }, ...this.recent.filter((entry) => entry.key !== key)].slice(0, 4);
    } else this.remember(key, result);
    return result;
  }

  private request(request: StreamdownCodeRequest): Promise<Outcome> {
    return new Promise((resolve) => {
      const job = { request, resolve };
      this.pending.set(request.id, job);
      void this.dispatch(job);
    });
  }

  private async createWorker(): Promise<WorkerConnection | null> {
    const WorkerConstructor = globalThis.Worker;
    if (!WorkerConstructor) return null;
    if (isVSCodeRuntime(null)) {
      const loading = new AbortController();
      this.loading = loading;
      const { default: url } = await import('./streamdown-code.worker.ts?worker&url');
      const response = await fetch(url, { signal: loading.signal });
      if (!response.ok) throw new Error('Code worker could not load');
      const blob = await response.blob();
      if (this.disposed || loading.signal.aborted) return null;
      const objectUrl = URL.createObjectURL(blob);
      try {
        return { worker: new WorkerConstructor(objectUrl, { type: 'module', name: 'streamdown-code' }), objectUrl };
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    }
    return { worker: new Worker(new URL('./streamdown-code.worker.ts', import.meta.url), { type: 'module', name: 'streamdown-code' }) };
  }

  private getWorker(): Promise<Worker | null> {
    if (this.worker) return Promise.resolve(this.worker);
    this.creation ??= this.createWorker().then((connection) => {
      if (!connection) return null;
      const { worker, objectUrl } = connection;
      if (this.disposed) {
        worker.terminate();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return null;
      }
      this.worker = worker;
      this.workerUrl = objectUrl ?? null;
      worker.onmessage = ({ data }: MessageEvent<StreamdownCodeResponse>) => {
        if (this.worker !== worker) return;
        const job = this.pending.get(data.id);
        if (job) this.finish(job, { status: 'ok', response: data });
      };
      worker.onerror = worker.onmessageerror = () => {
        if (this.worker === worker) this.failAll();
      };
      return worker;
    }).catch(() => null).finally(() => { this.creation = null; });
    return this.creation;
  }

  private async dispatch(job: Job): Promise<void> {
    const worker = await this.getWorker();
    if (this.disposed || this.pending.get(job.request.id) !== job) return;
    if (!worker) { this.finish(job, { status: 'failed' }); return; }
    // Work is serialized inside the worker. Every dispatched request gets the
    // original deadline; timeout survivors receive a fresh one after restart.
    job.timer = setTimeout(() => this.timeout(job), HIGHLIGHT_REQUEST_TIMEOUT_MS);
    try { worker.postMessage(job.request); }
    catch { this.failAll(); }
  }

  private timeout(job: Job): void {
    if (this.pending.get(job.request.id) !== job) return;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.stopWorker();
    this.finish(job, { status: 'timeout' });
    for (const survivor of this.pending.values()) void this.dispatch(survivor);
  }

  private finish(job: Job, outcome: Outcome): void {
    clearTimeout(job.timer);
    this.pending.delete(job.request.id);
    job.resolve(outcome);
  }

  private failAll(): void {
    this.stopWorker();
    for (const job of this.pending.values()) this.finish(job, { status: 'failed' });
    this.inflight.clear();
  }

  private stopWorker(): void {
    this.loading?.abort();
    this.loading = null;
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }

  dispose(): void {
    this.disposed = true;
    this.failAll();
    this.completed.clear();
    this.recent = [];
    this.snapshots = [];
    this.mainThreadPrevious = [];
  }
}

export const streamdownCodeWorker = new StreamdownCodeWorker();
