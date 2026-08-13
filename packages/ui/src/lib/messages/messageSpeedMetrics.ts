type TokenCache = {
    read?: number;
    write?: number;
};

export type TokenBreakdown = {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: TokenCache;
};

export type TimedPart = {
    type?: string;
    time?: {
        start?: number;
        end?: number;
        created?: number;
    } | null;
    tokens?: TokenBreakdown | number;
};

export type MessageSpeedMetrics = {
    ttftMs: number | null;
    throughputTps: number | null;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
};

const toNonNegative = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return 0;
    }
    return value;
};

const readBreakdown = (value: TokenBreakdown | number | undefined): TokenBreakdown | null => {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value;
};

const breakdownFromParts = (parts: TimedPart[]): TokenBreakdown | null => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part?.type !== 'step-finish') continue;
        const tokens = readBreakdown(part.tokens);
        if (tokens) return tokens;
    }
    return null;
};

export const deriveMessageSpeedMetrics = (input: {
    createdAt?: number;
    completedAt?: number;
    parts: TimedPart[];
    tokens?: TokenBreakdown | number;
}): MessageSpeedMetrics | null => {
    const tokens = readBreakdown(input.tokens) ?? breakdownFromParts(input.parts);
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : null;

    let firstPartStart: number | null = null;
    let lastPartEnd: number | null = null;
    for (const part of input.parts) {
        if (part.type !== 'reasoning' && part.type !== 'text') continue;
        const start = part.time?.start;
        const end = part.time?.end;
        if (typeof start === 'number' && Number.isFinite(start)) {
            if (firstPartStart === null || start < firstPartStart) firstPartStart = start;
        }
        if (typeof end === 'number' && Number.isFinite(end)) {
            if (lastPartEnd === null || end > lastPartEnd) lastPartEnd = end;
        }
    }

    const ttftMs =
        createdAt !== null && firstPartStart !== null && firstPartStart >= createdAt
            ? firstPartStart - createdAt
            : null;

    const output = toNonNegative(tokens?.output);
    const streamMs =
        firstPartStart !== null && lastPartEnd !== null && lastPartEnd > firstPartStart
            ? lastPartEnd - firstPartStart
            : null;
    const e2eMs =
        createdAt !== null &&
        typeof input.completedAt === 'number' &&
        Number.isFinite(input.completedAt) &&
        input.completedAt > createdAt
            ? input.completedAt - createdAt
            : null;
    const durationMs = streamMs ?? e2eMs;
    const throughputTps = durationMs && durationMs > 0 && output > 0 ? output / (durationMs / 1000) : null;

    const metrics: MessageSpeedMetrics = {
        ttftMs,
        throughputTps,
        input: toNonNegative(tokens?.input),
        cacheRead: toNonNegative(tokens?.cache?.read),
        cacheWrite: toNonNegative(tokens?.cache?.write),
        output,
        reasoning: toNonNegative(tokens?.reasoning),
    };

    const hasTokens =
        metrics.input > 0 ||
        metrics.cacheRead > 0 ||
        metrics.cacheWrite > 0 ||
        metrics.output > 0 ||
        metrics.reasoning > 0;
    if (!hasTokens && metrics.ttftMs === null) {
        return null;
    }
    return metrics;
};

export const formatDurationMs = (durationMs: number): string => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return '';
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 10) return `${totalSeconds.toFixed(2)}s`;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
};

export const formatTokenCount = (value: number): string => {
    return Math.round(toNonNegative(value)).toLocaleString('en-US');
};

export const formatThroughput = (tps: number): string => {
    if (!Number.isFinite(tps) || tps <= 0) return '';
    return tps >= 10 ? tps.toFixed(1) : tps.toFixed(2);
};
