import { useMemo, useState } from 'react';
import { Line, LinePath } from '@visx/shape';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import type { ReactNode } from 'react';
import { useChartTooltip } from './useChartTooltip';
import { useContainerWidth } from './useContainerWidth';
import { computeLineSeries } from './geometry';
import { seriesColor } from './palette';

interface LineChartDatum {
  label: string;
  /** One value per series, aligned with `seriesLabels`. */
  values: number[];
}

interface LineChartProps {
  data: readonly LineChartDatum[];
  seriesLabels: readonly string[];
  /** Container width in px. When omitted, the chart measures its parent. */
  width?: number;
  /** px. @default 180 */
  height?: number;
  formatValue?: (value: number) => string;
  /** Override a single series row inside the hover tooltip (e.g. provider logo + model name). */
  renderSeriesRow?: (seriesIndex: number, value: number) => ReactNode;
  ariaLabel: string;
}

const LABEL_HEIGHT = 20;
const MAX_LABELS = 8;
/** Above this day count, per-point dots are suppressed to avoid clutter. */
const DOT_THRESHOLD = 30;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

export function LineChart({
  data,
  seriesLabels,
  width,
  height = 180,
  formatValue = String,
  renderSeriesRow,
  ariaLabel,
}: LineChartProps) {
  const [ref, measured] = useContainerWidth<HTMLDivElement>();
  const w = width ?? measured;
  const { showTooltip, hideTooltip, TooltipPortal, tooltipOpen, tooltipData, containerRef } =
    useChartTooltip();
  const series = useMemo(
    () => (w > 0 ? computeLineSeries(data, w, height, LABEL_HEIGHT) : []),
    [data, w, height],
  );
  const chartHeight = Math.max(height - LABEL_HEIGHT, 1);
  const xScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, Math.max(data.length - 1, 1)],
        range: [0, Math.max(w, 1)],
      }),
    [data.length, w],
  );
  const labelEvery = Math.max(1, Math.ceil(data.length / MAX_LABELS));
  const showDots = data.length > 0 && data.length <= DOT_THRESHOLD;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const handleMove = (e: React.MouseEvent) => {
    if (data.length === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const idx = clamp(Math.round(xScale.invert(px)), 0, data.length - 1);
    setHoverIndex(idx);
    const day = data[idx]!;
    showTooltip(
      {
        key: day.label,
        content: (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">{day.label}</span>
            {series.map((s) => {
              const v = day.values[s.seriesIndex] ?? 0;
              return (
                <div key={s.seriesIndex}>
                  {renderSeriesRow ? (
                    renderSeriesRow(s.seriesIndex, v)
                  ) : (
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: seriesColor(s.seriesIndex) }}
                      />
                      <span className="text-xs text-muted-foreground">
                        {seriesLabels[s.seriesIndex] ?? ''}
                      </span>
                      <span className="ml-auto text-xs tabular-nums text-foreground">
                        {formatValue(v)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ),
      },
      e.clientX,
      e.clientY,
    );
  };

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0">
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={ariaLabel}
            onMouseMove={handleMove}
            onMouseLeave={() => {
              setHoverIndex(null);
              hideTooltip();
            }}
          >
            <Group>
              {series.map((s) => (
                <LinePath
                  key={s.seriesIndex}
                  data={s.points}
                  x={(d) => d.x}
                  y={(d) => d.y}
                  stroke={seriesColor(s.seriesIndex)}
                  strokeWidth={1.75}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {showDots &&
                series.flatMap((s) =>
                  s.points.map((p) => (
                    <circle
                      key={`${s.seriesIndex}-${p.index}`}
                      cx={p.x}
                      cy={p.y}
                      r={2}
                      fill={seriesColor(s.seriesIndex)}
                    />
                  )),
                )}
              {hoverIndex !== null && data.length > 1 && (
                <Line
                  from={{ x: xScale(hoverIndex), y: 0 }}
                  to={{ x: xScale(hoverIndex), y: chartHeight }}
                  stroke="var(--border)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  pointerEvents="none"
                />
              )}
              {data.map((d, i) =>
                i % labelEvery === 0 || i === data.length - 1 ? (
                  <text
                    key={`l-${d.label}-${i}`}
                    x={xScale(i)}
                    y={height - 4}
                    fontSize={10}
                    fill="currentColor"
                    className="text-muted-foreground"
                    textAnchor={
                      i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'
                    }
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
