import { Group } from '@visx/group';
import { scaleBand } from '@visx/scale';
import { useChartTooltip } from './useChartTooltip';
import { useContainerWidth } from './useContainerWidth';
import { computeBarRects } from './geometry';
import { seriesColor } from './palette';

interface BarChartDatum {
  label: string;
  value: number;
}

interface BarChartProps {
  data: readonly BarChartDatum[];
  /** Container width in px. When omitted, the chart measures its parent. */
  width?: number;
  /** px. @default 180 */
  height?: number;
  formatValue?: (value: number) => string;
  ariaLabel: string;
}

const LABEL_HEIGHT = 20;
const MAX_LABELS = 8;

export function BarChart({
  data,
  width,
  height = 180,
  formatValue = String,
  ariaLabel,
}: BarChartProps) {
  const [ref, measured] = useContainerWidth<HTMLDivElement>();
  const w = width ?? measured;
  const { showTooltip, hideTooltip, TooltipPortal, tooltipOpen, tooltipData, containerRef } =
    useChartTooltip();
  const rects = w > 0 ? computeBarRects(data, w, height, LABEL_HEIGHT) : [];
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
              {rects.map((r, i) => (
                <rect
                  key={data[i]!.label}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  rx={2}
                  fill={seriesColor(0)}
                  onMouseMove={(e) =>
                    showTooltip(
                      {
                        key: data[i]!.label,
                        content: (
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: seriesColor(0) }}
                            />
                            <span className="text-xs leading-tight">
                              {r.label}: {formatValue(r.value)}
                            </span>
                          </div>
                        ),
                      },
                      e.clientX,
                      e.clientY,
                    )
                  }
                  onMouseLeave={hideTooltip}
                />
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
