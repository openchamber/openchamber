import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2";
import type { SessionContextUsage } from "../types/sessionTypes";

type TokenBreakdown = {
    /** Server-reported window of the turn's final round-trip. Optional in the schema; absent on older servers. */
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
        read?: number;
        write?: number;
    };
};

export const sumTokenBreakdown = (breakdown: TokenBreakdown | null | undefined): number => {
    if (!breakdown || typeof breakdown !== 'object') {
        return 0;
    }

    const inputTokens = breakdown.input ?? 0;
    const outputTokens = breakdown.output ?? 0;
    const reasoningTokens = breakdown.reasoning ?? 0;
    const cacheReadTokens = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.read ?? 0 : 0;
    const cacheWriteTokens = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.write ?? 0 : 0;

    return inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
};

/**
 * Tokens the context window actually holds, from one message's token payload.
 *
 * The breakdown fields accumulate across every API round-trip inside a single
 * assistant turn: each tool call re-reads the whole (cached) prompt, so on a
 * multi-step turn `cache.read` alone can add up to several times the context
 * window (observed on opencode 1.18.18: cache.read 3,291,956 on a turn whose
 * 1M window really held 232,872 — rendered as a 330% context readout). The
 * server reports the final round-trip's window as `tokens.total` (optional in
 * the message schema, absent on older servers). Prefer it; fall back to
 * summing the fields only when the server did not send it.
 */
export const contextTokensFromBreakdown = (breakdown: TokenBreakdown | null | undefined): number => {
    if (!breakdown || typeof breakdown !== 'object') {
        return 0;
    }

    const reportedTotal = breakdown.total;
    if (typeof reportedTotal === 'number' && Number.isFinite(reportedTotal) && reportedTotal > 0) {
        return reportedTotal;
    }

    return sumTokenBreakdown(breakdown);
};

export type ContextFillMessage = {
    id?: string;
    role?: string;
    tokens?: TokenBreakdown;
    /** `true` on the assistant record of a compaction. User messages carry their diff summary here. */
    summary?: AssistantMessage['summary'] | UserMessage['summary'];
    finish?: AssistantMessage['finish'];
    error?: AssistantMessage['error'];
};

type LatestContextFill =
    | { state: 'measured'; index: number; totalTokens: number }
    /** Compacted since the last measured response; the current size is unknown. */
    | { state: 'compacted'; index: number };

/**
 * What the context window holds now, read from the newest message that can say.
 *
 * A compaction's own assistant record describes the summarizing request, not
 * the window left behind: its input is the pre-compaction history, and its
 * output leaves out the system prompt, the tools and the recent tail OpenCode
 * keeps. No number is right until the next response reports tokens, so a
 * finished compaction yields `compacted` instead of falling back to an older,
 * pre-compaction response. A compaction still running or one that failed has
 * not changed the window, so it is skipped and the previous reading stands.
 * "Finished" is OpenCode's own rule for a completed compaction
 * (`summary && finish && !error`): an overflowing compaction request gets
 * `time.completed` before its `error`, so the timestamp alone would briefly
 * report a failed compaction as done.
 */
export const findLatestContextFill = (messages: readonly ContextFillMessage[]): LatestContextFill | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;

        if (message.summary === true) {
            const finished = Boolean(message.finish) && !message.error;
            if (finished) return { state: 'compacted', index };
            continue;
        }

        const totalTokens = contextTokensFromBreakdown(message.tokens);
        if (totalTokens > 0) return { state: 'measured', index, totalTokens };
    }

    return null;
};

const DEFAULT_THRESHOLD_LIMIT = 200_000;

/** Header-style context usage for a session's messages, shared by every surface that renders `ContextUsageDisplay`. */
export const buildSessionContextUsage = (
    messages: readonly ContextFillMessage[],
    contextLimit: number,
    outputLimit: number,
): SessionContextUsage | null => {
    const fill = findLatestContextFill(messages);
    if (!fill) return null;

    const limits = {
        contextLimit: contextLimit > 0 ? contextLimit : 0,
        outputLimit: outputLimit > 0 ? outputLimit : undefined,
        thresholdLimit: contextLimit > 0 ? contextLimit : DEFAULT_THRESHOLD_LIMIT,
        lastMessageId: messages[fill.index]?.id,
    };

    if (fill.state === 'compacted') {
        return { state: 'compacted', ...limits };
    }

    const output = messages[fill.index]?.tokens?.output ?? 0;
    return {
        state: 'measured',
        ...limits,
        totalTokens: fill.totalTokens,
        percentage: contextLimit > 0 ? Math.round((fill.totalTokens / contextLimit) * 100) : 0,
        normalizedOutput: outputLimit > 0 ? Math.round((output / outputLimit) * 100) : undefined,
    };
};

export const isSameContextUsage = (a: SessionContextUsage | null, b: SessionContextUsage | null): boolean => {
    if (a === b) return true;
    if (!a || !b || a.state !== b.state) return false;

    const sameLimits = a.contextLimit === b.contextLimit
        && (a.outputLimit ?? 0) === (b.outputLimit ?? 0)
        && a.thresholdLimit === b.thresholdLimit
        && (a.lastMessageId ?? '') === (b.lastMessageId ?? '');
    if (!sameLimits) return false;
    if (a.state === 'compacted' || b.state === 'compacted') return true;

    return a.totalTokens === b.totalTokens
        && a.percentage === b.percentage
        && (a.normalizedOutput ?? 0) === (b.normalizedOutput ?? 0);
};

export const extractTokensFromMessage = (message: { info: Message; parts: Part[] }): number => {
    const tokens = (message.info as { tokens?: number | TokenBreakdown }).tokens;

    if (typeof tokens === 'number') {
        return tokens;
    }

    if (tokens && typeof tokens === 'object') {
        return contextTokensFromBreakdown(tokens);
    }

    const tokenPart = message.parts.find(
        (part) => typeof (part as { tokens?: number | TokenBreakdown }).tokens !== 'undefined'
    ) as { tokens?: number | TokenBreakdown } | undefined;

    if (!tokenPart || typeof tokenPart.tokens === 'undefined') {
        return 0;
    }

    if (typeof tokenPart.tokens === 'number') {
        return tokenPart.tokens;
    }

    return contextTokensFromBreakdown(tokenPart.tokens);
};

type CacheHitRateResult = {
    /** Cache hit rate as a 0-100 percentage. 0 when there is no input to compare against. */
    percent: number;
    /** True iff `breakdown` had a positive inclusive input total. When false, `percent` is meaningless. */
    hasInput: boolean;
};

/**
 * Compute prefix-cache hit rate from a token breakdown.
 *
 * The SDK reports `input` as the non-cached portion (total input minus
 * cache reads and cache writes). The full input processed by the model is
 * therefore:
 *
 *   totalInput = input + cache.read + cache.write
 *
 *   cacheHitRate = cache.read / totalInput
 *
 * Verified against the SDK source (`session.ts:getUsage`): `input` 
 * is `safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)`.
 *
 * Returns `hasInput: false` when there is no total input to compare against,
 * in which case `percent` is 0 and callers should hide the display.
 */
export const computeCacheHitRate = (breakdown: TokenBreakdown | null | undefined): CacheHitRateResult => {
    if (!breakdown || typeof breakdown !== 'object') {
        return { percent: 0, hasInput: false };
    }

    const input = breakdown.input ?? 0;
    const cacheRead = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.read ?? 0 : 0;
    const cacheWrite = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.write ?? 0 : 0;
    const total = input + cacheRead + cacheWrite;

    if (total <= 0) {
        return { percent: 0, hasInput: false };
    }

    const safeRead = Math.max(0, cacheRead);
    const percent = Math.min(100, Math.max(0, (safeRead / total) * 100));
    return { percent, hasInput: true };
};
