import type { AssistantMessage, Message, Part } from "@/lib/opencode/model";
import type { SessionContextUsage } from "../types/sessionTypes";

type TokenBreakdown = {
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
    status?: string;
    error?: AssistantMessage['error'];
};

type LatestContextFill =
    | { state: 'measured'; index: number; totalTokens: number }
    | { state: 'compacted'; index: number };

export const findLatestContextFill = (messages: readonly ContextFillMessage[]): LatestContextFill | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role === 'compaction') {
            if (message.status === 'completed' && !message.error) return { state: 'compacted', index };
            continue;
        }

        if (message?.role !== 'assistant') continue;

        const totalTokens = contextTokensFromBreakdown(message.tokens);
        if (totalTokens > 0) return { state: 'measured', index, totalTokens };
    }

    return null;
};

const DEFAULT_THRESHOLD_LIMIT = 200_000;

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
    percent: number;
    hasInput: boolean;
};

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
