import type { Part, ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';

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
    visibleParts: Part[],
    userCreatedAt: number,
): string | undefined {
    if (typeof userCreatedAt !== 'number') return undefined;
    let firstPartStart: number | undefined;
    for (const p of visibleParts) {
        if (p.type === 'text' || p.type === 'reasoning') {
            const t = (p as { time?: { start?: number } }).time;
            if (t && Number.isFinite(t.start)) {
                firstPartStart = t.start;
                break;
            }
        } else if (p.type === 'tool') {
            const state = (p as ToolPartType).state as Record<string, unknown> | undefined;
            const toolTime = state?.time as { start?: number } | undefined;
            if (toolTime && Number.isFinite(toolTime.start)) {
                firstPartStart = toolTime.start;
                break;
            }
        }
    }
    if (typeof firstPartStart !== 'number') return undefined;
    const ttft = firstPartStart - userCreatedAt;
    if (ttft <= 0 || !Number.isFinite(ttft)) return undefined;
    return ttft < 1000 ? `${ttft}ms` : `${(ttft / 1000).toFixed(1)}s`;
}
