import {
  formatCompactNumber,
  type HeatmapWeek,
} from "@/lib/analytics/aggregate";
import { HeatmapGrid, type HeatmapGridCell } from "./charts/HeatmapGrid";
import { ScrollToEnd } from "./charts/ScrollToEnd";
import { cn } from "@/lib/utils";
import { formatDateTimeForPreference } from "@/lib/timeFormat";

interface YearHeatmapLabels {
  title: string;
  less: string;
  more: string;
}

interface YearHeatmapBlockProps {
  weeks: readonly HeatmapWeek[];
  labels: YearHeatmapLabels;
  className?: string;
}

const monthOf = (day: string): number => Number(day.split("-")[1] ?? 1) - 1;

const toLocalDate = (day: string): Date => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
};

export function YearHeatmapBlock({
  weeks,
  labels,
  className,
}: YearHeatmapBlockProps) {
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
  const monthLabels: { index: number; label: string }[] = [];
  let prevMonth = -1;
  weeks.forEach((week, index) => {
    const first = week.find((c) => c !== null);
    if (!first) return;
    const month = monthOf(first.day);
    if (month !== prevMonth) {
      prevMonth = month;
      monthLabels.push({
        index,
        label: monthFmt.format(toLocalDate(first.day)),
      });
    }
  });

  // HeatmapGrid is row-major; the year calendar is naturally week-columns, so
  // transpose into 7 day-rows × N week-columns.
  const rows: (HeatmapGridCell | null)[][] = Array.from(
    { length: 7 },
    (_, day) =>
      weeks.map((week) => {
        const cell = week[day];
        if (!cell?.level) return null;
        const ts = new Date(cell.day).getTime();
        return {
          level: cell.level,
          tooltipKey: cell.day,
          tooltip: (
            <span className="text-xs leading-tight whitespace-nowrap">
              {`${formatDateTimeForPreference(ts, "auto", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}: ${formatCompactNumber(cell.tokens)}`}
            </span>
          ),
        };
      }),
  );

  return (
    <ScrollToEnd
      className={cn("overflow-x-auto", className)}
      dep={weeks.length}
    >
      <div className="min-w-150">
        <div className="relative h-5 text-xs overflow-hidden" aria-hidden>
          {monthLabels.map((m) => (
            <span
              key={`${m.index}-${m.label}`}
              className="absolute top-0 text-muted-foreground overflow-clip"
              style={{ left: `${(m.index / Math.max(1, weeks.length)) * 100}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <HeatmapGrid
          rows={rows}
          ariaLabel={labels.title}
          lessLabel={labels.less}
          moreLabel={labels.more}
        />
      </div>
    </ScrollToEnd>
  );
}
