import type { Message, Part } from '@opencode-ai/sdk/v2';

/**
 * Per-message API speed figures shown in the turn footer: how long the model
 * took to produce its first token, and how fast it decoded the rest.
 *
 * Both figures come from data opencode already persists — the `time` window on
 * text/reasoning parts and the usage report on the message — so no client-side
 * timing or new API surface is needed. When parts carry their streaming
 * windows, the decode window excludes tool-call waiting (each window is merged
 * rather than reading the message's created→completed span). When a provider
 * records no part timing, the rate falls back to output tokens over the
 * message's full created→completed span and TTFT is omitted.
 */
export interface MessageSpeedMetrics {
    /** Request-dispatch-to-first-token latency in milliseconds, when known. */
    ttftMs?: number;
    /** Output tokens per second of streaming decode time across all steps. */
    tokensPerSecond: number;
}

interface StreamingWindow {
    start: number;
    end: number;
}

const readStreamingWindow = (part: Part): StreamingWindow | null => {
    if (part.type !== 'text' && part.type !== 'reasoning') {
        return null;
    }
    const time = (part as { time?: { start?: unknown; end?: unknown } }).time;
    if (typeof time?.start !== 'number' || !Number.isFinite(time.start)) {
        return null;
    }
    // An open window (end unset while the part still streams) cannot bound a
    // rate yet, so only closed windows with a positive length count.
    if (typeof time.end !== 'number' || !Number.isFinite(time.end) || time.end <= time.start) {
        return null;
    }
    return { start: time.start, end: time.end };
};

const readStepFinishOutputTokens = (part: Part): number => {
    if (part.type !== 'step-finish') {
        return 0;
    }
    const output = (part as { tokens?: { output?: unknown } }).tokens?.output;
    return typeof output === 'number' && Number.isFinite(output) && output > 0 ? output : 0;
};

const readMessageOutputTokens = (info: Message): number | null => {
    const output = (info as { tokens?: { output?: unknown } }).tokens?.output;
    return typeof output === 'number' && Number.isFinite(output) && output > 0 ? output : null;
};

const readMessageTime = (info: Message, key: 'created' | 'completed'): number | null => {
    const value = (info as { time?: Record<string, unknown> }).time?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * Merge overlapping or adjacent streaming windows so interleaved text and
 * reasoning blocks (or parallel blocks) contribute their wall time once.
 */
const mergedWindowMs = (windows: StreamingWindow[]): number => {
    if (windows.length === 0) {
        return 0;
    }
    const sorted = [...windows].sort((left, right) => left.start - right.start);
    let total = 0;
    let current = sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
        const next = sorted[index];
        if (next.start <= current.end) {
            current = { start: current.start, end: Math.max(current.end, next.end) };
        } else {
            total += current.end - current.start;
            current = next;
        }
    }
    return total + current.end - current.start;
};

export const deriveMessageSpeedMetrics = (info: Message, parts: Part[]): MessageSpeedMetrics | null => {
    const windows: StreamingWindow[] = [];
    let firstWindowStart: number | null = null;
    let stepFinishTokens = 0;

    for (const part of parts) {
        const window = readStreamingWindow(part);
        if (window) {
            windows.push(window);
            if (firstWindowStart === null || window.start < firstWindowStart) {
                firstWindowStart = window.start;
            }
        }
        stepFinishTokens += readStepFinishOutputTokens(part);
    }

    // The message-level usage report is authoritative for what the provider
    // billed; the step-finish sum is the fallback for messages whose final
    // usage never landed.
    const outputTokens = readMessageOutputTokens(info) ?? stepFinishTokens;
    if (outputTokens <= 0) {
        return null;
    }

    const created = readMessageTime(info, 'created');
    const completed = readMessageTime(info, 'completed');
    let decodeMs: number;
    let ttftMs: number | undefined;

    if (windows.length > 0) {
        decodeMs = mergedWindowMs(windows);
        ttftMs = typeof created === 'number' && firstWindowStart !== null && firstWindowStart > created
            ? firstWindowStart - created
            : undefined;
    } else {
        // No part timing recorded (provider-dependent): the whole
        // created→completed span is the only window available, so the rate
        // spans first-token latency too and TTFT cannot be separated.
        if (typeof created !== 'number' || typeof completed !== 'number' || completed <= created) {
            return null;
        }
        decodeMs = completed - created;
    }
    if (decodeMs <= 0) {
        return null;
    }

    return {
        ttftMs,
        tokensPerSecond: outputTokens / (decodeMs / 1000),
    };
};
