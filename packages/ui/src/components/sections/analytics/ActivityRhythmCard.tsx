import { ChartCard } from "./ChartCard";
import { HeatmapGrid, type HeatmapGridCell } from "./charts/HeatmapGrid";

export interface ActivityRhythmCardLabels {
  title: string;
  ariaLabel: string;
  weekdayNames: string[];
  less: string;
  more: string;
}

interface ActivityRhythmCardProps {
  byWeekdayHour: readonly number[][];
  labels: ActivityRhythmCardLabels;
}

const HOUR_MARKS = new Set([0, 6, 12, 18, 23]);

const levelOf = (value: number, max: number): number => {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
};

export function ActivityRhythmCard({
  byWeekdayHour,
  labels,
}: ActivityRhythmCardProps) {
  const max = byWeekdayHour.reduce(
    (acc, row) => row.reduce((a, b) => Math.max(a, b), acc),
    0,
  );
  const source = byWeekdayHour.length > 0
    ? byWeekdayHour
    : (Array.from({ length: 7 }, () => []) as readonly number[][]);

  const rows: (HeatmapGridCell | null)[][] = source.map((row, weekday) =>
    Array.from({ length: 24 }, (_, hour) => {
      const value = row[hour] ?? 0;
      const weekdayName = labels.weekdayNames[weekday] ?? String(weekday);
      return {
        level: levelOf(value, max),
        tooltipKey: `${weekday}-${hour}`,
        tooltip: (
          <span className="text-xs leading-tight whitespace-nowrap">
            {weekdayName} · {hour}:00
          </span>
        ),
      };
    }),
  );

  const rowLabels = labels.weekdayNames.map((name) => (name ?? "").slice(0, 2));
  const columnLabels = Array.from(
    { length: 24 },
    (_, hour) => (HOUR_MARKS.has(hour) ? String(hour) : ""),
  );

  return (
    <ChartCard title={labels.title}>
      <HeatmapGrid
        rows={rows}
        rowLabels={rowLabels}
        columnLabels={columnLabels}
        ariaLabel={labels.ariaLabel}
        lessLabel={labels.less}
        moreLabel={labels.more}
        className="text-xs"
      />
    </ChartCard>
  );
}
