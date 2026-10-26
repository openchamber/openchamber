import React from 'react';

import { DEFAULT_CONTEXT_LIMIT } from '@/components/chat/work-status/contextUsage';
import { useSubagentCostRollup } from '@/components/chat/work-status/useSubagentCostRollup';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { useI18n } from '@/lib/i18n';
import type { Message } from '@/lib/opencode/model';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { findLatestContextFill } from '@/stores/utils/tokenUtils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessagesSelector } from '@/sync/sync-context';

type ContextFillReading = { state: 'measured'; totalTokens: number } | { state: 'compacted' } | null;

const selectContextFill = (messages: Message[]): ContextFillReading => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;
  return fill.state === 'measured' ? { state: 'measured', totalTokens: fill.totalTokens } : { state: 'compacted' };
};

const isSameContextFill = (a: ContextFillReading, b: ContextFillReading): boolean => {
  if (a === null || b === null) return a === b;
  if (a.state !== b.state) return false;
  return a.state === 'compacted' || (b.state === 'measured' && a.totalTokens === b.totalTokens);
};

/**
 * The current session's context fill. A streamed step replaces the message
 * list many times while the fill stays the same, so callers re-render only
 * when a response reports a new token count or a compaction finishes.
 */
const useCurrentContextReading = () => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const fill = useSessionMessagesSelector(sessionId ?? '', directory, selectContextFill, isSameContextFill);
  const { context } = useContextWindowLimits(sessionId, directory);
  const limit = context > 0 ? context : DEFAULT_CONTEXT_LIMIT;
  return { sessionId, fill, limit };
};

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
};

const RING_SIZE = 18;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Rail icon for the Context surface: an outline ring whose arc is the share of
 * the context window in use. Drawn in the button's own colour, so it follows
 * the rail's idle, hover and active states like the other icons. An empty
 * track means nothing is measured yet, or a compaction made the fill unknown.
 */
export const ContextUsageRingIcon: React.FC<{ className?: string }> = ({ className }) => {
  const { fill, limit } = useCurrentContextReading();
  const percent = fill?.state === 'measured' ? Math.min(100, (fill.totalTokens / limit) * 100) : 0;

  return (
    <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className={cn('shrink-0', className)} aria-hidden="true">
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={RING_STROKE}
      />
      {percent > 0 ? (
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      ) : null}
    </svg>
  );
};

/**
 * Context readings under the rail tooltip's description. Mounted only while
 * the tooltip is open: the cost rollup reads every live session, which changes
 * on each streamed step.
 */
export const ContextRailTooltipDetails: React.FC = () => {
  const { t } = useI18n();
  const { sessionId, fill, limit } = useCurrentContextReading();
  const { totalCost } = useSubagentCostRollup(sessionId);
  if (!sessionId || !fill) return null;

  const lines = [
    fill.state === 'measured'
      ? t('contextUsage.tooltip.usedTokens', { tokens: formatTokens(fill.totalTokens) })
      : t('contextUsage.compacted.description'),
    t('contextUsage.tooltip.contextLimit', { tokens: formatTokens(limit) }),
    ...(totalCost !== null && totalCost > 0 ? [t('contextUsage.tooltip.cost', { cost: formatMoney(totalCost) })] : []),
  ];

  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t border-border/60 pt-1 tabular-nums">
      {lines.map((line) => (
        <span key={line} className="typography-micro text-muted-foreground">{line}</span>
      ))}
    </div>
  );
};
