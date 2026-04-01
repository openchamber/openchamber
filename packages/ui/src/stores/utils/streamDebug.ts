export const streamDebugEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem('openchamber_stream_debug') === '1';
    } catch {
        return false;
    }
};

export const sessionStatusDebugEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem('openchamber_session_status_debug') === '1';
    } catch {
        return false;
    }
};

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

export type StreamPerfEntry = {
    metric: string;
    count: number;
    avg: number;
    max: number;
    total: number;
    last: number;
};

export type StreamPerfSnapshot = {
    enabled: boolean;
    startedAt: number | null;
    lastUpdatedAt: number | null;
    durationMs: number;
    entries: StreamPerfEntry[];
};

declare global {
    interface Window {
        __openchamberStreamPerfState?: StreamPerfState;
        __openchamberVsCodeStreamPerfState?: {
            counters: Map<string, PerfCounter>;
            lastReportAt?: number;
            lastUpdatedAt?: number;
            reportTimer?: number | null;
            startedAt?: number;
        };
    }
}

export const streamPerfEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
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

const ensureStreamPerfState = (): StreamPerfState | null => {
    if (!streamPerfEnabled() || typeof window === 'undefined') {
        return null;
    }

    if (!window.__openchamberStreamPerfState) {
        const startedAt = Date.now();
        window.__openchamberStreamPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt,
            lastUpdatedAt: startedAt,
        };
    }

    return window.__openchamberStreamPerfState;
};

const normalizePerfEntries = (counters: Map<string, PerfCounter>): StreamPerfEntry[] => {
    return Array.from(counters.entries())
        .map(([metric, bucket]) => ({
            metric,
            count: bucket.count,
            avg: bucket.count > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
            max: Number(bucket.max.toFixed(3)),
            total: Number(bucket.total.toFixed(3)),
            last: Number(bucket.last.toFixed(3)),
        }))
        .sort((a, b) => b.total - a.total || b.count - a.count);
};

const updatePerfCounter = (metric: string, amount: number): void => {
    const state = ensureStreamPerfState();
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

export const setStreamPerfEnabled = (enabled: boolean): void => {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        if (enabled) {
            window.localStorage.setItem(STREAM_PERF_STORAGE_KEY, '1');
            window.__openchamberStreamPerfState = {
                counters: new Map<string, PerfCounter>(),
                startedAt: Date.now(),
                lastUpdatedAt: Date.now(),
            };
            return;
        }

        window.localStorage.removeItem(STREAM_PERF_STORAGE_KEY);
        delete window.__openchamberStreamPerfState;
        delete window.__openchamberVsCodeStreamPerfState;
    } catch {
        // ignore storage failures in debug helper
    }
};

export const resetStreamPerf = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    if (streamPerfEnabled()) {
        window.__openchamberStreamPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
        };
    }

    if (window.__openchamberVsCodeStreamPerfState) {
        window.__openchamberVsCodeStreamPerfState = {
            ...window.__openchamberVsCodeStreamPerfState,
            counters: new Map<string, PerfCounter>(),
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
        };
    }
};

export const getStreamPerfSnapshot = (): StreamPerfSnapshot => {
    if (typeof window === 'undefined') {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    const state = window.__openchamberStreamPerfState;
    if (!streamPerfEnabled() || !state) {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    return {
        enabled: true,
        startedAt: state.startedAt,
        lastUpdatedAt: state.lastUpdatedAt,
        durationMs: Math.max(0, Date.now() - state.startedAt),
        entries: normalizePerfEntries(state.counters),
    };
};

export const getVsCodeStreamPerfSnapshot = (): StreamPerfSnapshot => {
    if (typeof window === 'undefined') {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    const state = window.__openchamberVsCodeStreamPerfState;
    if (!streamPerfEnabled() || !state) {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    const startedAt = typeof state.startedAt === 'number' ? state.startedAt : null;
    const lastUpdatedAt = typeof state.lastUpdatedAt === 'number' ? state.lastUpdatedAt : null;
    return {
        enabled: true,
        startedAt,
        lastUpdatedAt,
        durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
        entries: normalizePerfEntries(state.counters),
    };
};

export const streamPerfCount = (metric: string, count = 1): void => {
    updatePerfCounter(metric, count);
};

export const streamPerfObserve = (metric: string, value: number): void => {
    updatePerfCounter(metric, value);
};

export const streamPerfMeasure = <T>(metric: string, fn: () => T): T => {
    if (!streamPerfEnabled()) {
        return fn();
    }

    const start = nowMs();
    try {
        return fn();
    } finally {
        updatePerfCounter(metric, nowMs() - start);
    }
};
