const STREAM_PERF_STORAGE_KEY = 'openchamber_stream_perf';

type PerfCounter = {
  count: number;
  total: number;
  max: number;
  last: number;
};

type StreamPerfState = {
  counters: Map<string, PerfCounter>;
  startedAt: number;
  lastUpdatedAt: number;
};

declare global {
  interface Window {
    __openchamberVsCodeStreamPerfState__?: StreamPerfState;
  }
}

export const vscodeStreamPerfEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(STREAM_PERF_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const nowMs = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const ensurePerfState = (): StreamPerfState | null => {
  if (!vscodeStreamPerfEnabled()) {
    return null;
  }

  if (!window.__openchamberVsCodeStreamPerfState__) {
    const startedAt = Date.now();
    window.__openchamberVsCodeStreamPerfState__ = {
      counters: new Map<string, PerfCounter>(),
      startedAt,
      lastUpdatedAt: startedAt,
    };
  }

  return window.__openchamberVsCodeStreamPerfState__;
};

const updateCounter = (metric: string, amount: number): void => {
  const state = ensurePerfState();
  if (!state) {
    return;
  }

  const bucket = state.counters.get(metric) ?? { count: 0, total: 0, max: 0, last: 0 };
  bucket.count += 1;
  bucket.total += amount;
  bucket.max = Math.max(bucket.max, amount);
  bucket.last = amount;
  state.counters.set(metric, bucket);
  state.lastUpdatedAt = Date.now();
};

export const vscodeStreamPerfCount = (metric: string, count = 1): void => {
  updateCounter(metric, count);
};

export const vscodeStreamPerfObserve = (metric: string, value: number): void => {
  updateCounter(metric, value);
};

export const vscodeStreamPerfMeasure = <T>(metric: string, fn: () => T): T => {
  if (!vscodeStreamPerfEnabled()) {
    return fn();
  }

  const start = nowMs();
  try {
    return fn();
  } finally {
    updateCounter(metric, nowMs() - start);
  }
};
