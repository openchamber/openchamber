import { findLatestContextFill, type ContextFillMessage } from '@/stores/utils/tokenUtils';

export type CompactContextUsage =
    | {
        state: 'measured';
        totalTokens: number;
        contextLimit: number;
        percentage: number;
    }
    | {
        state: 'unknown';
        reason: 'no-reading' | 'missing-limit' | 'compacted';
    };

type CompactContextTone = 'neutral' | 'warning' | 'error';

export const computeCompactContextUsage = (
    messages: readonly ContextFillMessage[],
    contextLimit: number,
): CompactContextUsage => {
    const fill = findLatestContextFill(messages);
    if (!fill) return { state: 'unknown', reason: 'no-reading' };
    if (fill.state === 'compacted') return { state: 'unknown', reason: 'compacted' };
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
        return { state: 'unknown', reason: 'missing-limit' };
    }

    return {
        state: 'measured',
        totalTokens: fill.totalTokens,
        contextLimit,
        percentage: (fill.totalTokens / contextLimit) * 100,
    };
};

export const getCompactContextTone = (usage: CompactContextUsage): CompactContextTone => {
    if (usage.state !== 'measured') return 'neutral';
    if (usage.percentage >= 90) return 'error';
    if (usage.percentage >= 75) return 'warning';
    return 'neutral';
};

type CompactContextTranslator = (
    key: 'contextUsage.compact.summary' | 'contextUsage.compacted.description' | 'contextUsage.aria.label',
    params?: { used?: string; limit?: string; percent?: string },
) => string;

export const formatCompactContextSummary = (
    usage: CompactContextUsage,
    translate: CompactContextTranslator,
): string => {
    if (usage.state === 'measured') {
        return translate('contextUsage.compact.summary', {
            used: formatCompactContextTokens(usage.totalTokens),
            limit: formatCompactContextTokens(usage.contextLimit),
            percent: formatCompactContextPercent(usage.percentage),
        });
    }
    if (usage.reason === 'compacted') return translate('contextUsage.compacted.description');
    return `${translate('contextUsage.aria.label')}: \u2014`;
};

const formatCompactContextTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    }
    return String(Math.round(tokens));
};

const formatCompactContextPercent = (percentage: number): string => `${percentage.toFixed(1)}%`;
