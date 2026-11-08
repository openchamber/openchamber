import React from 'react';

import { useSubagentCostRollup } from '@/components/chat/work-status/useSubagentCostRollup';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useCurrentContextReading } from './useCurrentContextReading';

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
};

const RING_SIZE = 18;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The ring alone; `arcColor` paints the filled arc, the track stays in the text colour. */
export const ContextRing: React.FC<{ percent: number; arcColor?: string; className?: string }> = ({ percent: rawPercent, arcColor = 'currentColor', className }) => {
  const percent = Math.min(100, Math.max(0, rawPercent));
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
          stroke={arcColor}
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
    <div className="mt-1 flex flex-col gap-0.5 border-t border-edge pt-1 tabular-nums">
      {lines.map((line) => (
        <span key={line} className="typography-micro text-muted-foreground">{line}</span>
      ))}
    </div>
  );
};
