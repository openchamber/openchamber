import {
  formatCompactNumber,
  type DailyTokenBreakdown,
} from "@/lib/analytics/aggregate";
import { StackedBarChart } from "./charts/StackedBarChart";
import { BrushableTimeSeries } from "./charts/BrushableTimeSeries";
import { buildStackedRows } from "./charts/geometry";
import { seriesColor } from "./charts/palette";

export interface TokenBreakdownChartLabels {
  title: string;
  ariaLabel: string;
  prompt: string;
  completion: string;
  reasoning: string;
  cached: string;
}

const dayLabel = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(year!, (month ?? 1) - 1, date));
};

export function TokenBreakdownChart({
  breakdown,
  labels,
}: {
  breakdown: readonly DailyTokenBreakdown[];
  labels: TokenBreakdownChartLabels;
}) {
  const seriesLabels = [
    labels.prompt,
    labels.completion,
    labels.reasoning,
    labels.cached,
  ];
  const data = breakdown.map((b) => ({
    label: dayLabel(b.day),
    segments: [b.prompt, b.completion, b.reasoning, b.cached],
  }));
  return (
    <div>
      <BrushableTimeSeries
        data={data}
        renderInner={({ data: visible, width, height }) => (
          <StackedBarChart
            data={visible}
            seriesLabels={seriesLabels}
            width={width}
            height={height}
            formatValue={formatCompactNumber}
            ariaLabel={labels.ariaLabel}
          />
        )}
        renderOverview={({ data: full, width, height }) =>
          buildStackedRows(full, width, height, 0).flatMap((row, di) =>
            row.bars.map((bar) => (
              <rect
                key={`${full[di]!.label}-${bar.seriesIndex}`}
                x={row.x}
                y={bar.y}
                width={row.width}
                height={bar.height}
                fill={seriesColor(bar.seriesIndex)}
                opacity={0.5}
              />
            )),
          )
        }
      />
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {seriesLabels.map((label, index) => (
          <li
            key={label}
            className="flex items-center gap-1.5 text-muted-foreground"
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: seriesColor(index) }}
            />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
