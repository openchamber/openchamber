import React from 'react';
import type { UsageMetricMode } from '@/lib/quota';
import type { DailyUsagePoint } from '@/lib/quota/usagePeriodStats';

interface SeriesDef {
  id: string;
  label: string;
  color: string;
}

interface UsageAreaChartProps {
  days: DailyUsagePoint[];
  metric: UsageMetricMode;
  series: SeriesDef[];
  ariaLabel: string;
  emptyLabel: string;
}

const metricValue = (point: DailyUsagePoint, metric: UsageMetricMode, seriesId: string | null): number => {
  if (!seriesId) {
    if (metric === 'cost') return point.cost;
    if (metric === 'requests') return point.requests;
    return point.tokens;
  }
  const bucket = point.byProvider[seriesId];
  if (!bucket) return 0;
  if (metric === 'cost') return bucket.cost;
  if (metric === 'requests') return bucket.requests;
  return bucket.tokens;
};

const buildAreaPath = (
  values: number[],
  width: number,
  height: number,
  maxValue: number,
): string => {
  if (values.length === 0) return '';
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - (maxValue <= 0 ? 0 : (value / maxValue) * height);
    return `${x},${y}`;
  });
  return `M0,${height} L${points.join(' L')} L${width},${height} Z`;
};

const buildLinePath = (
  values: number[],
  width: number,
  height: number,
  maxValue: number,
): string => {
  if (values.length === 0) return '';
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (maxValue <= 0 ? 0 : (value / maxValue) * height);
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
};

export const UsageAreaChart: React.FC<UsageAreaChartProps> = ({
  days,
  metric,
  series,
  ariaLabel,
  emptyLabel,
}) => {
  const width = 640;
  const height = 180;
  const seriesValues = React.useMemo(
    () => series.map((entry) => days.map((day) => metricValue(day, metric, entry.id))),
    [days, metric, series],
  );
  const maxValue = React.useMemo(() => {
    let max = 0;
    for (const values of seriesValues) {
      for (const value of values) {
        if (value > max) max = value;
      }
    }
    return max;
  }, [seriesValues]);

  const hasData = maxValue > 0;

  return (
    <div className="w-full" role="img" aria-label={ariaLabel}>
      {!hasData ? (
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-[var(--interactive-border)] typography-meta text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[180px] w-full overflow-visible" preserveAspectRatio="none">
          {series.map((entry, index) => {
            const values = seriesValues[index] ?? [];
            return (
              <g key={entry.id}>
                <path
                  d={buildAreaPath(values, width, height, maxValue)}
                  fill={entry.color}
                  fillOpacity={0.18}
                />
                <path
                  d={buildLinePath(values, width, height, maxValue)}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
};
