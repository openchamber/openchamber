import type { Message, Part } from "@opencode-ai/sdk/v2";

type TokenBreakdown = {
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

export const extractTokensFromMessage = (message: { info: Message; parts: Part[] }): number => {
    const tokens = (message.info as { tokens?: number | TokenBreakdown }).tokens;

    if (typeof tokens === 'number') {
        return tokens;
    }

    if (tokens && typeof tokens === 'object') {
        return sumTokenBreakdown(tokens);
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

    return sumTokenBreakdown(tokenPart.tokens);
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

export interface SessionCostAndCounts {
    totalCost: number;
    userCount: number;
    assistantCount: number;
}

export const computeSessionCostAndCounts = (messages: Message[]): SessionCostAndCounts => {
    let totalCost = 0;
    let userCount = 0;
    let assistantCount = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as { role?: string; cost?: number };
        if (msg.role === 'user') {
            userCount++;
        } else if (msg.role === 'assistant') {
            assistantCount++;
            if (typeof msg.cost === 'number' && Number.isFinite(msg.cost) && msg.cost > 0) {
                totalCost += msg.cost;
            }
        }
    }

    return { totalCost, userCount, assistantCount };
};

export interface SessionTokenRate {
    avgTokensPerSecond: number;
}

type ToolPartLike = {
    type: string;
    state?: unknown;
};

type PartGetter = (messageId: string) => ToolPartLike[] | undefined;

export const computeSessionTokenRate = (
    messages: Message[],
    getParts?: PartGetter,
): SessionTokenRate => {
    let totalGeneratedTokens = 0;
    let totalGenerationMs = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as {
            role?: string;
            id?: string;
            time?: { created?: number; completed?: number };
            tokens?: { output?: number; reasoning?: number };
        };
        if (msg.role !== 'assistant') continue;

        const created = msg.time?.created;
        const completed = msg.time?.completed;
        if (typeof created !== 'number' || typeof completed !== 'number' || completed <= created) continue;

        const tokens = msg.tokens;
        if (!tokens) continue;
        const generatedTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
        if (generatedTokens <= 0) continue;

        let durationMs = completed - created;

        if (getParts && msg.id) {
            const parts = getParts(msg.id);
            if (parts) {
                for (let j = 0; j < parts.length; j++) {
                    const part = parts[j];
                    if (part.type !== 'tool') continue;
                    const toolTime = (part.state as { time?: { start?: number; end?: number } } | undefined)?.time;
                    if (toolTime && typeof toolTime.start === 'number' && typeof toolTime.end === 'number') {
                        const toolDuration = toolTime.end - toolTime.start;
                        if (toolDuration > 0) durationMs -= toolDuration;
                    }
                }
            }
        }

        if (durationMs <= 0) continue;

        totalGeneratedTokens += generatedTokens;
        totalGenerationMs += durationMs;
    }

    const avgTokensPerSecond = totalGenerationMs > 0
        ? totalGeneratedTokens / (totalGenerationMs / 1000)
        : 0;

    return { avgTokensPerSecond };
};
