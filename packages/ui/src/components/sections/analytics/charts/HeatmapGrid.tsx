import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { useChartTooltip } from "./useChartTooltip";
import type { ReactNode } from "react";

/** Intensity ramp for heatmap cells (level 0..4). Level 0 is the muted
 *  placeholder; 1..4 scale the branded chart color via color-mix. */
const HEATMAP_LEVEL_CLASSES = [
  "bg-foreground/5",
  "bg-[color-mix(in_srgb,var(--chart-1)_25%,transparent)]",
  "bg-[color-mix(in_srgb,var(--chart-1)_45%,transparent)]",
  "bg-[color-mix(in_srgb,var(--chart-1)_65%,transparent)]",
  "bg-[color-mix(in_srgb,var(--chart-1)_90%,transparent)]",
] as const;

export interface HeatmapGridCell {
  /** 0..4 intensity. 0 (or a `null` matrix entry) renders the placeholder. */
  level: number;
  tooltipKey: string | number;
  tooltip: ReactNode;
}

interface HeatmapGridProps {
  /** Row-major cell matrix. A `null` entry renders an empty placeholder cell
   *  (no tooltip). All rows must have equal length. */
  rows: readonly (readonly (HeatmapGridCell | null)[])[];
  ariaLabel: string;
  /** Optional leading-column label per row (e.g. weekday names). When present,
   *  a `2.5ch` label column is prepended to the grid. */
  rowLabels?: readonly string[];
  /** Optional header-row label per column (e.g. hour marks). */
  columnLabels?: readonly string[];
  /** When both are set, a less→more legend is rendered below the grid. */
  lessLabel?: string;
  moreLabel?: string;
  className?: string;
}

const cellClass = (cell: HeatmapGridCell | null): string =>
  cn(
    "aspect-square rounded-xs cursor-default",
    cell ? HEATMAP_LEVEL_CLASSES[cell.level] ?? HEATMAP_LEVEL_CLASSES[0] : HEATMAP_LEVEL_CLASSES[0],
  );

export function HeatmapGrid({
  rows,
  ariaLabel,
  rowLabels,
  columnLabels,
  lessLabel,
  moreLabel,
  className,
}: HeatmapGridProps) {
  const { showTooltip, hideTooltip, TooltipPortal, tooltipOpen, tooltipData, containerRef } =
    useChartTooltip();
  const colCount = rows[0]?.length ?? 0;
  const gridTemplateColumns = `${rowLabels ? "2.5ch " : ""}repeat(${colCount}, minmax(0, 1fr))`;
  const hasLegend = lessLabel !== undefined && moreLabel !== undefined;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns }}
        role="img"
        aria-label={ariaLabel}
      >
        {columnLabels ? (
          <Fragment>
            {rowLabels ? <div /> : null}
            {columnLabels.map((label, i) => (
              <div
                key={`c-${i}`}
                className="text-center text-[0.75em] leading-none text-muted-foreground"
              >
                {label}
              </div>
            ))}
          </Fragment>
        ) : null}
        {rows.map((row, r) => (
          <Fragment key={`r-${r}`}>
            {rowLabels ? (
              <div className="self-center text-end pr-1 leading-none text-muted-foreground">
                {rowLabels[r] ?? ""}
              </div>
            ) : null}
            {row.map((cell, c) => (
              <div
                key={`${r}-${c}`}
                className={cellClass(cell)}
                onMouseMove={
                  cell
                    ? (e) =>
                        showTooltip(
                          { key: cell.tooltipKey, content: cell.tooltip },
                          e.clientX,
                          e.clientY,
                        )
                    : undefined
                }
                onMouseLeave={hideTooltip}
              />
            ))}
          </Fragment>
        ))}
      </div>
      {hasLegend ? (
        <div className="mt-2 flex items-center justify-end gap-1 text-xs text-muted-foreground sticky right-0">
          <span>{lessLabel}</span>
          {HEATMAP_LEVEL_CLASSES.map((cls, i) => (
            <div key={i} className={cn("size-2 rounded-xs", cls)} />
          ))}
          <span>{moreLabel}</span>
        </div>
      ) : null}
      <TooltipPortal>{tooltipOpen ? tooltipData?.content : null}</TooltipPortal>
    </div>
  );
}
