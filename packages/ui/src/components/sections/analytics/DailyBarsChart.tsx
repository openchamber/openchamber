import { formatCompactNumber, formatCostUsd, type DailyBucket } from '@/lib/analytics/aggregate';
import { BarChart } from './charts/BarChart';
import { BrushableTimeSeries } from './charts/BrushableTimeSeries';
import { computeBarRects } from './charts/geometry';
import { seriesColor } from './charts/palette';

const dayLabel = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(year!, (month ?? 1) - 1, date));
};

export function DailyBarsChart({ daily, metric, ariaLabel }: {
  daily: readonly DailyBucket[];
  metric: 'cost' | 'sessions';
  ariaLabel: string;
}) {
  const formatValue = metric === 'cost' ? formatCostUsd : formatCompactNumber;
  const data = daily.map((b) => ({ label: dayLabel(b.day), value: b[metric] }));
  return (
    <BrushableTimeSeries
      data={data}
      renderInner={({ data: visible, width, height }) => (
        <BarChart
          data={visible}
          width={width}
          height={height}
          formatValue={formatValue}
          ariaLabel={ariaLabel}
        />
      )}
      renderOverview={({ data: full, width, height }) =>
        computeBarRects(full, width, height, 0).map((r, i) => (
          <rect
            key={full[i]!.label}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill={seriesColor(0)}
            opacity={0.5}
          />
        ))
      }
    />
  );
}

