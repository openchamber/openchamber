import { Group } from '@visx/group';
import { scaleBand } from '@visx/scale';
import type { ReactNode } from 'react';
import { useChartTooltip } from './useChartTooltip';
import { useContainerWidth } from './useContainerWidth';
import { buildStackedRows } from './geometry';
import { seriesColor } from './palette';

interface StackedBarDatum {
  label: string;
  segments: number[];
}

interface StackedBarChartProps {
  data: readonly StackedBarDatum[];
  seriesLabels: readonly string[];
  width?: number;
  height?: number;
  formatValue?: (value: number) => string;
  /** Full control over a segment's tooltip body (e.g. color dot + provider). */
  renderTooltipContent?: (seriesIndex: number, value: number, label: string) => ReactNode;
  ariaLabel: string;
}

const LABEL_HEIGHT = 20;
const MAX_LABELS = 8;

export function StackedBarChart({
  data,
  seriesLabels,
  width,
  height = 160,
  formatValue = String,
  renderTooltipContent,
  ariaLabel,
}: StackedBarChartProps) {
  const [ref, measured] = useContainerWidth<HTMLDivElement>();
  const w = width ?? measured;
  const { showTooltip, hideTooltip, TooltipPortal, tooltipOpen, tooltipData, containerRef } =
    useChartTooltip();
  const rows = w > 0 ? buildStackedRows(data, w, height, LABEL_HEIGHT) : [];
  const labelX = scaleBand<string>({
    domain: data.map((d) => d.label),
    range: [0, Math.max(w, 1)],
    padding: 0.25,
  });
  const labelEvery = Math.max(1, Math.ceil(data.length / MAX_LABELS));

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0">
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={ariaLabel}>
            <Group>
              {rows.map((row, i) => (
                <Group key={data[i]!.label}>
                  {row.bars.map((bar) => (
                    <rect
                      key={bar.seriesIndex}
                      x={row.x}
                      y={bar.y}
                      width={row.width}
                      height={bar.height}
                      fill={seriesColor(bar.seriesIndex)}
                      onMouseMove={(e) => {
                        const content = renderTooltipContent ? (
                          renderTooltipContent(bar.seriesIndex, bar.value, data[i]!.label)
                        ) : (
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: seriesColor(bar.seriesIndex) }}
                            />
                            <span className="text-xs leading-tight">
                              {data[i]!.label} · {seriesLabels[bar.seriesIndex] ?? ''}: {formatValue(bar.value)}
                            </span>
                          </div>
                        );
                        showTooltip(
                          {
                            key: `${data[i]!.label}-${bar.seriesIndex}`,
                            content,
                          },
                          e.clientX,
                          e.clientY,
                        );
                      }}
                      onMouseLeave={hideTooltip}
                    />
                  ))}
                </Group>
              ))}
              {data.map((d, i) =>
                i % labelEvery === 0 ? (
                  <text
                    key={`l-${d.label}`}
                    x={labelX(d.label) ?? 0}
                    y={height - 4}
                    fontSize={10}
                    fill="currentColor"
                    className="text-muted-foreground"
                  >
                    {d.label}
                  </text>
                ) : null,
              )}
            </Group>
          </svg>
        )}
        <TooltipPortal>{tooltipOpen ? tooltipData?.content : null}</TooltipPortal>
      </div>
    </div>
  );
}
