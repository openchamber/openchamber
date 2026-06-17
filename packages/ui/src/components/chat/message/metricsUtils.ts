import type { Part, ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';

export function computeEarliestPartStart(
    assistantMessages: { parts: Part[] }[],
): number | undefined {
    let earliest: number | undefined;
    for (const msg of assistantMessages) {
        for (const p of msg.parts) {
            let start: number | undefined;
            if (p.type === 'text' || p.type === 'reasoning') {
                start = (p as { time?: { start?: number } }).time?.start;
            } else if (p.type === 'tool') {
                const state = (p as ToolPartType).state as Record<string, unknown> | undefined;
                start = (state?.time as { start?: number } | undefined)?.start;
            }
            if (typeof start === 'number' && Number.isFinite(start) && (earliest === undefined || start < earliest)) {
                earliest = start;
            }
        }
    }
    return earliest;
}

export function computeTpsText(
    visibleParts: Part[],
    outputTokens: number,
): string | undefined {
    if (typeof outputTokens !== 'number' || outputTokens <= 0) return undefined;
    let lastTextEnd: number | undefined;
    let lastTextStart: number | undefined;
    let textPartCount = 0;
    for (let i = visibleParts.length - 1; i >= 0; i--) {
        const p = visibleParts[i];
        if (p.type === 'text') {
            const t = (p as { time?: { start?: number; end?: number } }).time;
            if (t && Number.isFinite(t.start) && Number.isFinite(t.end)) {
                if (lastTextEnd === undefined) {
                    lastTextEnd = t.end;
                    lastTextStart = t.start;
                }
                textPartCount++;
            }
        } else if (p.type === 'reasoning') {
            const reasoningTime = (p as { time?: { start?: number } }).time;
            if (reasoningTime && typeof reasoningTime.start === 'number' && Number.isFinite(reasoningTime.start)) {
                return undefined;
            }
        }
    }
    if (textPartCount > 1 || typeof lastTextStart !== 'number' || typeof lastTextEnd !== 'number') return undefined;
    const textDurationMs = lastTextEnd - lastTextStart;
    if (textDurationMs < 100) return undefined;
    const tps = outputTokens / (textDurationMs / 1000);
    if (!Number.isFinite(tps)) return undefined;
    return `${tps.toFixed(1)} t/s`;
}

export function computeTtftText(
    earliestPartStart: number | undefined,
    userCreatedAt: number | undefined,
): string | undefined {
    if (typeof earliestPartStart !== 'number' || !Number.isFinite(earliestPartStart)) return undefined;
    if (typeof userCreatedAt !== 'number' || !Number.isFinite(userCreatedAt)) return undefined;
    const ttft = earliestPartStart - userCreatedAt;
    if (ttft <= 0 || !Number.isFinite(ttft)) return undefined;
    return ttft < 1000 ? `${ttft}ms` : `${(ttft / 1000).toFixed(1)}s`;
}
