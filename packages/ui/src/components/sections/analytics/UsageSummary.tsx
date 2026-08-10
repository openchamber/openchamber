import { LinePath } from "@visx/shape";
import {
  formatCompactNumber,
  formatCostUsd,
  type AnalyticsKpis,
  type ByModelDaily,
  type DailyBucket,
  type ModelUsageEntry,
} from "@/lib/analytics/aggregate";
import { deltaKind, deltaPercent, formatDeltaPercent } from "./delta";
import { StackedBarChart } from "./charts/StackedBarChart";
import { BarChart } from "./charts/BarChart";
import { LineChart } from "./charts/LineChart";
import { DonutChart } from "./charts/DonutChart";
import { BrushableTimeSeries } from "./charts/BrushableTimeSeries";
import {
  buildStackedRows,
  computeBarRects,
  computeLineSeries,
} from "./charts/geometry";
import { seriesColor } from "./charts/palette";
import { Button } from "@/components/ui/button";
import { SortableTabsStrip } from "@/components/ui/sortable-tabs-strip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { ProviderLogo } from "@/components/ui/ProviderLogo";
import { cn } from "@/lib/utils";

export type HeroMetric = "tokens" | "cost" | "sessions";
export type HeroView = "daily" | "total";

/** Extra catalog metadata for a model key (`providerID/modelID`), resolved by the
 *  container from the providers catalog. Optional — when absent the component
 *  falls back to the aggregate label (keeps it hook-free and unit-testable). */
export interface ModelMeta {
  displayName: string;
  providerName?: string;
  providerId?: string;
  reasoning?: boolean;
}

export interface UsageSummaryLabels {
  metrics: { tokens: string; cost: string; sessions: string };
  view: { daily: string; total: string };
  viewAria: string;
  chartToggleAria: string;
  chartTypeBar: string;
  chartTypeLine: string;
  topModels: string;
  other: string;
  deltaUp: string;
  deltaDown: string;
  deltaNew: string;
  deltaFlat: string;
  ariaLabel: string;
}

export type HeroChartType = "bar" | "line";

interface UsageSummaryProps {
  kpis: AnalyticsKpis;
  daily: readonly DailyBucket[];
  byModelDaily: readonly ByModelDaily[];
  byModelDailyCost: readonly ByModelDaily[];
  topModelKeys: readonly string[];
  models: readonly ModelUsageEntry[];
  metric: HeroMetric;
  onChangeMetric: (metric: HeroMetric) => void;
  view: HeroView;
  onChangeView: (view: HeroView) => void;
  /** Daily chart rendering style; controlled by the parent. @default "bar" */
  chartType?: HeroChartType;
  onChangeChartType?: (chartType: HeroChartType) => void;
  deltaEnabled: boolean;
  labels: UsageSummaryLabels;
  resolveModelMeta?: (key: string) => ModelMeta | undefined;
}

const METRIC_ICONS: Record<HeroMetric, IconName> = {
  tokens: "archive-stack",
  cost: "bar-chart-2",
  sessions: "chat-history",
};

const dayLabel = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(year!, (month ?? 1) - 1, date));
};

export function UsageSummary({
  kpis,
  daily,
  byModelDaily,
  byModelDailyCost,
  topModelKeys,
  models,
  metric,
  onChangeMetric,
  view,
  onChangeView,
  chartType = "bar",
  onChangeChartType,
  deltaEnabled,
  labels,
  resolveModelMeta,
}: UsageSummaryProps) {
  const current =
    metric === "cost"
      ? kpis.totalCost
      : metric === "sessions"
        ? kpis.sessionCount
        : kpis.totalTokens;
  const prev =
    metric === "cost"
      ? kpis.prevTotalCost
      : metric === "sessions"
        ? kpis.prevSessionCount
        : kpis.prevTotalTokens;
  const formatValue = metric === "cost" ? formatCostUsd : formatCompactNumber;

  const seriesKeys = [...topModelKeys, "other"];
  const legendLabels = topModelKeys
    .map((key) => key.split("/").pop() ?? key)
    .concat(labels.other);

  const metricValueOf = (entry: ModelUsageEntry | undefined): number =>
    metric === "cost"
      ? (entry?.cost ?? 0)
      : metric === "sessions"
        ? (entry?.sessions ?? 0)
        : (entry?.tokens ?? 0);

  const byKey = new Map(models.map((m) => [m.key, m]));
  const topRows = topModelKeys
    .map((key, seriesIndex) => {
      const entry = byKey.get(key);
      const value = metricValueOf(entry);
      const meta = resolveModelMeta?.(key);
      return {
        key,
        seriesIndex,
        label: meta?.displayName ?? entry?.label ?? key.split("/").pop() ?? key,
        value,
        reasoning: meta?.reasoning ?? false,
        providerName: meta?.providerName,
        providerId: meta?.providerId,
      };
    })
    .sort((a, b) => b.value - a.value);
  const rawMax = Math.max(...topRows.map((row) => row.value));
  // Divide by the real max so the leader fills the track (100%). Only fall back
  // to 1 when every value is 0, to avoid divide-by-zero (bars then render 0%).
  const maxRowValue = rawMax > 0 ? rawMax : 1;

  // Total-view donut: per-model share of the selected metric + aggregated Other.
  const topValues = topModelKeys.map((key) => metricValueOf(byKey.get(key)));
  const topSum = topValues.reduce((acc, v) => acc + v, 0);
  const totalForMetric = current;
  const otherValue = Math.max(0, totalForMetric - topSum);
  const donutValues = [...topValues, otherValue];
  // Donut segments are in topModelKeys order; map a segment index back to its
  // (possibly sorted-away) row so the tooltip shows the RIGHT model, not the
  // row that happens to sit at the same sorted position.
  const rowBySeriesIndex = new Map(
    topRows.map((row) => [row.seriesIndex, row]),
  );

  /** Legend-style series row: color dot + provider logo + model name +
   *  reasoning icon + provider name + value. Shared by the donut and the daily
   *  stacked-bar tooltips so both mirror the "Top models" list on the left. */
  const renderSeriesRow = (seriesIndex: number, value: number) => {
    const row = rowBySeriesIndex.get(seriesIndex);
    return (
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: seriesColor(seriesIndex) }}
        />
        {row?.providerId ? (
          <ProviderLogo
            providerId={row.providerId}
            className="size-3 shrink-0"
          />
        ) : null}
        <span className="max-w-[160px] truncate text-xs text-foreground">
          {row ? row.label : labels.other}
        </span>
        {row?.reasoning ? (
          <Icon
            name="brain-ai-3"
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : null}
        {row?.providerName ? (
          <span className="truncate text-xs text-muted-foreground">
            {row.providerName}
          </span>
        ) : null}
        <span className="ml-1 text-xs tabular-nums text-muted-foreground">
          {formatValue(value)}
        </span>
      </div>
    );
  };

  const dailySessions = daily.map((b) => ({
    label: dayLabel(b.day),
    value: b.sessions,
  }));
  const dailySessionsLine = dailySessions.map((d) => ({
    label: d.label,
    values: [d.value],
  }));
  const dailyStacked = (
    metric === "cost" ? byModelDailyCost : byModelDaily
  ).map((b) => ({
    label: dayLabel(b.day),
    segments: seriesKeys.map((key) => b.series[key] ?? 0),
  }));
  const dailyStackedLine = dailyStacked.map((d) => ({
    label: d.label,
    values: d.segments,
  }));

  /** Thin line overview for the brush strip, shared by both line variants. */
  const renderLineOverview = ({
    data: full,
    width,
    height,
  }: {
    data: readonly { label: string; values: number[] }[];
    width: number;
    height: number;
  }) =>
    computeLineSeries(full, width, height, 0).map((s) => (
      <LinePath
        key={s.seriesIndex}
        data={s.points}
        x={(d) => d.x}
        y={(d) => d.y}
        stroke={seriesColor(s.seriesIndex)}
        strokeWidth={1}
        fill="none"
        opacity={0.5}
      />
    ));

  const renderChart = () => {
    if (view === "total") {
      return (
        <DonutChart
          values={donutValues}
          ariaLabel={labels.ariaLabel}
          className="mx-auto"
          renderTooltipContent={(index, value) => renderSeriesRow(index, value)}
        />
      );
    }
    const isLine = chartType === "line";
    if (metric === "sessions") {
      return isLine ? (
        <BrushableTimeSeries
          data={dailySessionsLine}
          renderInner={({ data: visible, width, height }) => (
            <LineChart
              data={visible}
              seriesLabels={[labels.metrics.sessions]}
              width={width}
              height={height}
              formatValue={formatCompactNumber}
              ariaLabel={labels.ariaLabel}
            />
          )}
          renderOverview={renderLineOverview}
        />
      ) : (
        <BrushableTimeSeries
          data={dailySessions}
          renderInner={({ data: visible, width, height }) => (
            <BarChart
              data={visible}
              width={width}
              height={height}
              formatValue={formatCompactNumber}
              ariaLabel={labels.ariaLabel}
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
    return isLine ? (
      <BrushableTimeSeries
        data={dailyStackedLine}
        renderInner={({ data: visible, width, height }) => (
          <LineChart
            data={visible}
            seriesLabels={legendLabels}
            width={width}
            height={height}
            formatValue={formatValue}
            ariaLabel={labels.ariaLabel}
            renderSeriesRow={(seriesIndex, value) =>
              renderSeriesRow(seriesIndex, value)
            }
          />
        )}
        renderOverview={renderLineOverview}
      />
    ) : (
      <BrushableTimeSeries
        data={dailyStacked}
        renderInner={({ data: visible, width, height }) => (
          <StackedBarChart
            data={visible}
            seriesLabels={legendLabels}
            width={width}
            height={height}
            formatValue={formatValue}
            ariaLabel={labels.ariaLabel}
            renderTooltipContent={(seriesIndex, value, dayLabel) => (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  {dayLabel}
                </span>
                {renderSeriesRow(seriesIndex, value)}
              </div>
            )}
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
    );
  };
  const chart = renderChart();

  const kind = deltaKind(current, prev);
  const pct = deltaPercent(current, prev);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex max-sm:flex-col sm:items-center gap-2">
        <SortableTabsStrip
          items={(["tokens", "cost", "sessions"] as const).map((option) => ({
            id: option,
            label: labels.metrics[option],
            icon: <Icon name={METRIC_ICONS[option]} className="h-4 w-4" />,
          }))}
          activeId={metric}
          onSelect={(id) => onChangeMetric(id as HeroMetric)}
          layoutMode="fit"
          variant="active-pill"
          className="h-8 flex-none grow"
        />
        <Select value={view} onValueChange={(v) => onChangeView(v as HeroView)}>
          <SelectTrigger
            size="lg"
            aria-label={labels.viewAria}
            className="ml-auto"
          >
            <SelectValue>
              {(value) => labels.view[value as HeroView] ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">{labels.view.daily}</SelectItem>
            <SelectItem value="total">{labels.view.total}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <div className="min-w-0 flex flex-wrap items-center gap-2">
          <div className="text-2xl font-semibold tabular-nums text-foreground">
            {formatValue(current)}
          </div>
          {deltaEnabled && kind !== "flat" ? (
            <span
              className={cn(
                "border rounded-full text-xs py-0.5 px-2",
                kind === "down"
                  ? "text-status-error border-status-error bg-status-error/25"
                  : "text-status-success border-status-success bg-status-success/25",
              )}
            >
              {kind === "new"
                ? labels.deltaNew
                : (kind === "up" ? labels.deltaUp : labels.deltaDown).replace(
                    "{value}",
                    formatDeltaPercent(pct),
                  )}
            </span>
          ) : null}
          {view === "daily" && onChangeChartType ? (
            <div
              role="group"
              aria-label={labels.chartToggleAria}
              className="ms-auto flex w-fit items-stretch has-[>[data-slot=button-group]]:gap-2 *:focus-visible:relative *:focus-visible:z-10 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none"
              data-slot="button-group"
            >
              <Button
                type="button"
                variant='chip'
                size="xs"
                aria-pressed={chartType === "bar"}
                aria-label={labels.chartTypeBar}
                onClick={() => onChangeChartType("bar")}
              >
                <Icon name="bar-chart-grouped" className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant='chip'
                size="xs"
                aria-pressed={chartType === "line"}
                aria-label={labels.chartTypeLine}
                onClick={() => onChangeChartType("line")}
              >
                <Icon name="line-chart" className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
          <div className="mt-2 w-full">{chart}</div>
        </div>
        <div className="min-w-0">
          <div className="typography-micro text-muted-foreground">
            {labels.topModels}
          </div>
          <ul className="mt-2 grid gap-x-2 gap-y-2.5 grid-cols-[minmax(0,1fr)_auto]">
            {topRows.map((row) => (
              <li
                key={row.key}
                className="grid col-span-full items-center grid-cols-subgrid"
              >
                <div className="min-w-0 flex items-center gap-1">
                  {row.providerId ? (
                    <ProviderLogo
                      providerId={row.providerId}
                      className="size-4 shrink-0"
                    />
                  ) : null}

                  <span className="min-w-0 truncate text-sm text-foreground">
                    {row.label}
                  </span>
                  {row.reasoning ? (
                    <Icon
                      name="brain-ai-3"
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                  {row.providerName ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{row.providerName}</span>
                    </div>
                  ) : null}
                </div>
                <span className="text-end text-sm tabular-nums text-muted-foreground">
                  {formatValue(row.value)}
                </span>

                <div className="h-1 rounded-full bg-muted col-span-2">
                  {!!row.value && (
                    <div
                      className="h-1 rounded-full"
                      style={{
                        width: `${(row.value / maxRowValue) * 100}%`,
                        backgroundColor: seriesColor(row.seriesIndex),
                      }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
