// Tracks every fetch() request as "in flight" from call to promise settle,
// samples two series once per second, and keeps a 5-minute rolling window for
// plotting:
//   1. in-flight request count
//   2. percentile distribution of currently in-flight request ages: p50, p90,
//      p99, max (ms since each unsettled fetch started; 0 when nothing is in
//      flight)
// Mirrors the streamDebug.ts pattern: collection is gated behind an
// enable/disable toggle (driven by the debug panel), state lives on `window`
// to survive HMR, and the UI polls a serializable snapshot instead of
// subscribing to a store (this is high-frequency debug data, see stores docs).

const STORAGE_KEY = 'openchamber_requests_in_flight';
const SAMPLE_INTERVAL_MS = 1000;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = Math.ceil(WINDOW_MS / SAMPLE_INTERVAL_MS);

type RequestsInFlightState = {
    enabled: boolean;
    startedAt: number;
    inFlight: number;
    peak: number;
    totalStarted: number;
    totalSettled: number;
    samples: number[];
    p50Samples: number[];
    p90Samples: number[];
    p99Samples: number[];
    maxSamples: number[];
    peakAgeMs: number;
    inFlightStarts: Map<number, number>;
    sampleCount: number;
    lastSampleAt: number | null;
    fetchWrapped: boolean;
    originalFetch: typeof window.fetch | null;
    sampleTimer: number | null;
};

export type RequestsInFlightSnapshot = {
    enabled: boolean;
    startedAt: number | null;
    durationMs: number;
    inFlight: number;
    peak: number;
    totalStarted: number;
    totalSettled: number;
    samples: number[];
    ageP50: number;
    ageP90: number;
    ageP99: number;
    ageMax: number;
    peakAgeMs: number;
    p50Samples: number[];
    p90Samples: number[];
    p99Samples: number[];
    maxSamples: number[];
    sampleCount: number;
    lastSampleAt: number | null;
    windowSeconds: number;
};

declare global {
    interface Window {
        __openchamberRequestsInFlight__?: RequestsInFlightState;
    }
}

export const requestsInFlightEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

const createState = (): RequestsInFlightState => {
    const startedAt = Date.now();
    return {
        enabled: true,
        startedAt,
        inFlight: 0,
        peak: 0,
        totalStarted: 0,
        totalSettled: 0,
        samples: [],
        p50Samples: [],
        p90Samples: [],
        p99Samples: [],
        maxSamples: [],
        peakAgeMs: 0,
        inFlightStarts: new Map<number, number>(),
        sampleCount: 0,
        lastSampleAt: null,
        fetchWrapped: false,
        originalFetch: null,
        sampleTimer: null,
    };
};

let nextRequestId = 1;

const recordStart = (id: number, startMs: number): void => {
    const state = window.__openchamberRequestsInFlight__;
    if (!state || !state.enabled) return;
    state.inFlight += 1;
    state.totalStarted += 1;
    if (state.inFlight > state.peak) state.peak = state.inFlight;
    state.inFlightStarts.set(id, startMs);
};

const recordSettle = (id: number): void => {
    const state = window.__openchamberRequestsInFlight__;
    if (!state || !state.enabled) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.totalSettled += 1;
    state.inFlightStarts.delete(id);
};

// Sorted ages (ms) of every currently in-flight request. Empty when nothing
// is in flight. Used both for live snapshot reporting and per-second sampling.
const currentAges = (state: RequestsInFlightState): number[] => {
    if (state.inFlightStarts.size === 0) return [];
    const now = Date.now();
    const ages: number[] = [];
    for (const start of state.inFlightStarts.values()) {
        ages.push(Math.max(0, now - start));
    }
    ages.sort((a, b) => a - b);
    return ages;
};

// Linear-interpolation percentile of a pre-sorted array.
const percentile = (sorted: number[], p: number): number => {
    const n = sorted.length;
    if (n === 0) return 0;
    if (n === 1) return sorted[0];
    const rank = (p / 100) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
};

const installFetchTracker = (): void => {
    if (typeof window === 'undefined') return;
    const state = window.__openchamberRequestsInFlight__;
    if (!state || state.fetchWrapped) return;
    const original = window.fetch.bind(window);
    state.originalFetch = original;
    state.fetchWrapped = true;
    const tracker = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const id = nextRequestId++;
        recordStart(id, Date.now());
        try {
            return await original(input, init);
        } finally {
            recordSettle(id);
        }
    };
    window.fetch = tracker as typeof window.fetch;
};

const uninstallFetchTracker = (): void => {
    if (typeof window === 'undefined') return;
    const state = window.__openchamberRequestsInFlight__;
    if (!state || !state.fetchWrapped || !state.originalFetch) return;
    window.fetch = state.originalFetch;
    state.fetchWrapped = false;
    state.originalFetch = null;
};

const trimSamples = (arr: number[]): void => {
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
};

const pushSample = (): void => {
    const state = window.__openchamberRequestsInFlight__;
    if (!state || !state.enabled) return;
    state.samples.push(state.inFlight);
    const ages = currentAges(state);
    const mx = ages.length > 0 ? ages[ages.length - 1] : 0;
    state.p50Samples.push(percentile(ages, 50));
    state.p90Samples.push(percentile(ages, 90));
    state.p99Samples.push(percentile(ages, 99));
    state.maxSamples.push(mx);
    if (mx > state.peakAgeMs) state.peakAgeMs = mx;
    state.sampleCount += 1;
    trimSamples(state.samples);
    trimSamples(state.p50Samples);
    trimSamples(state.p90Samples);
    trimSamples(state.p99Samples);
    trimSamples(state.maxSamples);
    state.lastSampleAt = Date.now();
};

const startSampling = (): void => {
    if (typeof window === 'undefined') return;
    const state = window.__openchamberRequestsInFlight__;
    if (!state || state.sampleTimer != null) return;
    state.sampleTimer = window.setInterval(pushSample, SAMPLE_INTERVAL_MS);
};

const stopSampling = (): void => {
    if (typeof window === 'undefined') return;
    const state = window.__openchamberRequestsInFlight__;
    if (!state || state.sampleTimer == null) return;
    window.clearInterval(state.sampleTimer);
    state.sampleTimer = null;
};

export const setRequestsInFlightTrackingEnabled = (enabled: boolean): void => {
    if (typeof window === 'undefined') return;

    try {
        if (enabled) {
            // Idempotent: tear down any prior tracking first so a repeated
            // enable can never wrap window.fetch twice (which would double-count).
            stopSampling();
            uninstallFetchTracker();
            window.localStorage.setItem(STORAGE_KEY, '1');
            window.__openchamberRequestsInFlight__ = createState();
            installFetchTracker();
            startSampling();
            return;
        }

        window.localStorage.removeItem(STORAGE_KEY);
        stopSampling();
        uninstallFetchTracker();
        delete window.__openchamberRequestsInFlight__;
    } catch {
        // ignore storage failures in debug helper
    }
};

export const resetRequestsInFlight = (): void => {
    if (typeof window === 'undefined') return;
    const state = window.__openchamberRequestsInFlight__;
    if (!state) return;
    const fresh = createState();
    state.startedAt = fresh.startedAt;
    state.inFlight = fresh.inFlight;
    state.peak = fresh.peak;
    state.totalStarted = fresh.totalStarted;
    state.totalSettled = fresh.totalSettled;
    state.samples = fresh.samples;
    state.p50Samples = fresh.p50Samples;
    state.p90Samples = fresh.p90Samples;
    state.p99Samples = fresh.p99Samples;
    state.maxSamples = fresh.maxSamples;
    state.peakAgeMs = fresh.peakAgeMs;
    state.inFlightStarts = fresh.inFlightStarts;
    state.sampleCount = fresh.sampleCount;
    state.lastSampleAt = fresh.lastSampleAt;
};

export const getRequestsInFlightSnapshot = (): RequestsInFlightSnapshot => {
    if (typeof window === 'undefined') {
        return emptySnapshot();
    }

    const state = window.__openchamberRequestsInFlight__;
    if (!requestsInFlightEnabled() || !state) {
        return emptySnapshot();
    }

    const ages = currentAges(state);
    return {
        enabled: true,
        startedAt: state.startedAt,
        durationMs: Math.max(0, Date.now() - state.startedAt),
        inFlight: state.inFlight,
        peak: state.peak,
        totalStarted: state.totalStarted,
        totalSettled: state.totalSettled,
        samples: state.samples.slice(),
        ageP50: percentile(ages, 50),
        ageP90: percentile(ages, 90),
        ageP99: percentile(ages, 99),
        ageMax: ages.length > 0 ? ages[ages.length - 1] : 0,
        peakAgeMs: state.peakAgeMs,
        p50Samples: state.p50Samples.slice(),
        p90Samples: state.p90Samples.slice(),
        p99Samples: state.p99Samples.slice(),
        maxSamples: state.maxSamples.slice(),
        sampleCount: state.sampleCount,
        lastSampleAt: state.lastSampleAt,
        windowSeconds: MAX_SAMPLES,
    };
};

const emptySnapshot = (): RequestsInFlightSnapshot => ({
    enabled: false,
    startedAt: null,
    durationMs: 0,
    inFlight: 0,
    peak: 0,
    totalStarted: 0,
    totalSettled: 0,
    samples: [],
    ageP50: 0,
    ageP90: 0,
    ageP99: 0,
    ageMax: 0,
    peakAgeMs: 0,
    p50Samples: [],
    p90Samples: [],
    p99Samples: [],
    maxSamples: [],
    sampleCount: 0,
    lastSampleAt: null,
    windowSeconds: MAX_SAMPLES,
});
