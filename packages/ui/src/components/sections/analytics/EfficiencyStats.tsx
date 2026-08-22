import {
  formatCompactNumber,
  formatCostUsd,
  type AnalyticsKpis,
} from '@/lib/analytics/aggregate';

export interface EfficiencyStatsLabels {
  costPerMillion: string;
  costPerSession: string;
  tokensPerSession: string;
  reasoningShare: string;
  avgDuration: string;
  medianDuration: string;
  longestDuration: string;
}

interface EfficiencyStatsProps {
  kpis: Pick<
    AnalyticsKpis,
    | 'costPerMillion'
    | 'costPerSession'
    | 'tokensPerSession'
    | 'reasoningShare'
    | 'avgSessionDurationMs'
    | 'medianSessionDurationMs'
    | 'longestSessionDurationMs'
  >;
  labels: EfficiencyStatsLabels;
}

const formatDuration = (ms: number): string => {
  if (ms <= 0) return '0m';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

export function EfficiencyStats({ kpis, labels }: EfficiencyStatsProps) {
  const cards: { label: string; value: string }[] = [
    { label: labels.costPerMillion, value: formatCostUsd(kpis.costPerMillion) },
    { label: labels.costPerSession, value: formatCostUsd(kpis.costPerSession) },
    {
      label: labels.tokensPerSession,
      value: formatCompactNumber(kpis.tokensPerSession),
    },
    {
      label: labels.reasoningShare,
      value: `${Math.round(kpis.reasoningShare * 100)}%`,
    },
    {
      label: labels.avgDuration,
      value: formatDuration(kpis.avgSessionDurationMs),
    },
    {
      label: labels.medianDuration,
      value: formatDuration(kpis.medianSessionDurationMs),
    },
    {
      label: labels.longestDuration,
      value: formatDuration(kpis.longestSessionDurationMs),
    },
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border bg-card px-3 py-2.5">
          <div className="text-xs text-muted-foreground">{card.label}</div>
          <div className="mt-0.5">
            <span className="text-lg font-medium tabular-nums text-foreground">
              {card.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
