import type { ReactNode } from "react";
import {
  formatCompactNumber,
  formatCostUsd,
  type AnalyticsKpis,
  type DailyBucket,
  type DailyTokenBreakdown,
} from "@/lib/analytics/aggregate";
import { deltaKind, deltaPercent, formatDeltaPercent } from "./delta";
import { Sparkline } from "./charts/Sparkline";
import { cn } from "@/lib/utils";

export interface StatCardRowLabels {
  tokens: string;
  cost: string;
  sessions: string;
  cacheHitRate: string;
  activeDays: string;
  streak: string;
  deltaUp: string;
  deltaDown: string;
  deltaNew: string;
  deltaFlat: string;
}

interface StatCardRowProps {
  kpis: AnalyticsKpis;
  daily: readonly DailyBucket[];
  dailyBreakdown: readonly DailyTokenBreakdown[];
  deltaEnabled: boolean;
  labels: StatCardRowLabels;
}

const substitute = (template: string, pct: number): string =>
  template.replace("{value}", formatDeltaPercent(pct));

function renderDelta({
  current,
  prev,
  labels,
  deltaEnabled,
}: {
  current: number;
  prev: number;
  labels: StatCardRowLabels;
  deltaEnabled: boolean;
}): ReactNode {
  if (!deltaEnabled) {
    return (
      <span className="typography-micro text-muted-foreground">
        {labels.deltaFlat}
      </span>
    );
  }
  const kind = deltaKind(current, prev);
  if (kind === "new") {
    return (
      <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-chart-2/25 text-chart-2 border border-chart-2">
        {labels.deltaNew}
      </span>
    );
  }
  if (kind === "flat") {
    return (
      <span className="typography-micro text-muted-foreground">
        {labels.deltaFlat}
      </span>
    );
  }
  const pct = deltaPercent(current, prev);
  return (
    <span
      className={cn(
        "text-xs",
        kind === "up" ? "text-status-success" : "text-status-error",
      )}
    >
      {substitute(kind === "up" ? labels.deltaUp : labels.deltaDown, pct)}
    </span>
  );
}

function StatCard({
  label,
  value,
  delta,
  sparkline,
  sub,
}: {
  label: string;
  value: string;
  delta?: ReactNode;
  sparkline?: ReactNode;
  sub?: ReactNode;
}) {
  const deltaOrSub = delta || sub;
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-end justify-between gap-2">
        <span className="text-lg font-medium tabular-nums text-foreground">
          {value}
        </span>
        {sparkline}
      </div>
      {!!deltaOrSub && <div className="mt-0.5">{deltaOrSub}</div>}
    </div>
  );
}

export function StatCardRow({
  kpis,
  daily,
  dailyBreakdown,
  deltaEnabled,
  labels,
}: StatCardRowProps) {
  const cacheSeries = dailyBreakdown.map((b) => {
    const total = b.prompt + b.cached;
    return total > 0 ? (b.cached / total) * 100 : 0;
  });
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2">
      <StatCard
        label={labels.tokens}
        value={formatCompactNumber(kpis.totalTokens)}
        sparkline={
          <Sparkline
            values={daily.map((d) => d.tokens)}
            tone={
              deltaKind(kpis.totalTokens, kpis.prevTotalTokens) === "down"
                ? "down"
                : "up"
            }
          />
        }
        delta={renderDelta({
          current: kpis.totalTokens,
          prev: kpis.prevTotalTokens,
          labels,
          deltaEnabled,
        })}
      />
      <StatCard
        label={labels.cost}
        value={formatCostUsd(kpis.totalCost)}
        sparkline={
          <Sparkline
            values={daily.map((d) => d.cost)}
            tone={
              deltaKind(kpis.totalCost, kpis.prevTotalCost) === "down"
                ? "down"
                : "up"
            }
          />
        }
        delta={renderDelta({
          current: kpis.totalCost,
          prev: kpis.prevTotalCost,
          labels,
          deltaEnabled,
        })}
      />
      <StatCard
        label={labels.sessions}
        value={formatCompactNumber(kpis.sessionCount)}
        sparkline={
          <Sparkline
            values={daily.map((d) => d.sessions)}
            tone={
              deltaKind(kpis.sessionCount, kpis.prevSessionCount) === "down"
                ? "down"
                : "up"
            }
          />
        }
        delta={renderDelta({
          current: kpis.sessionCount,
          prev: kpis.prevSessionCount,
          labels,
          deltaEnabled,
        })}
      />
      <StatCard
        label={labels.cacheHitRate}
        value={`${Math.round(kpis.cacheHitRate * 100)}%`}
        sparkline={<Sparkline values={cacheSeries} tone="neutral" />}
      />
      <StatCard
        label={labels.activeDays}
        value={formatCompactNumber(kpis.activeDays)}
      />
      <StatCard
        label={labels.streak}
        value={formatCompactNumber(kpis.currentStreak)}
      />
    </div>
  );
}
