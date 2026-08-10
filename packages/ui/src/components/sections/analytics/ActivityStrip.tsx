import {
  formatCompactNumber,
  type AnalyticsKpis,
  type HeatmapWeek,
} from "@/lib/analytics/aggregate";
import { YearHeatmapBlock } from "./YearHeatmapBlock";

export interface ActivityStripLabels {
  metricCaption: string;
  longestStreak: string;
  avgPerDay: string;
  avgPerWeek: string;
  total: string;
  days: string;
  heatmap: { title: string; less: string; more: string };
}

interface ActivityStripProps {
  weeks: readonly HeatmapWeek[];
  kpis: AnalyticsKpis;
  labels: ActivityStripLabels;
}

export function ActivityStrip({ weeks, kpis, labels }: ActivityStripProps) {
  const stats: { label: string; value: string }[] = [
    {
      label: labels.longestStreak,
      value: `${formatCompactNumber(kpis.longestStreak)} ${labels.days}`,
    },
    {
      label: labels.avgPerDay,
      value: formatCompactNumber(kpis.avgTokensPerActiveDay),
    },
    { label: labels.avgPerWeek, value: formatCompactNumber(kpis.avgPerWeek) },
    { label: labels.total, value: formatCompactNumber(kpis.totalTokens) },
  ];

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {stats.map((stat) => (
          <span key={stat.label} className="flex flex-col">
            <span className="text-xs text-muted-foreground">{stat.label}</span>
            <span className="text-lg font-medium tabular-nums text-foreground">
              {stat.value}
            </span>
          </span>
        ))}
      </div>

      <YearHeatmapBlock weeks={weeks} labels={labels.heatmap} />
    </div>
  );
}
