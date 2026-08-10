import { Pie } from '@visx/shape';
import { Group } from '@visx/group';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { seriesColor } from './palette';
import { useChartTooltip } from './useChartTooltip';

interface DonutChartProps {
  values: readonly number[];
  /** Per-segment labels, aligned with `values`. Shown in the hover tooltip. */
  labels?: readonly string[];
  /** Full control over the tooltip body (e.g. color dot + provider). */
  renderTooltipContent?: (index: number, value: number) => ReactNode;
  /** Format a segment value for the tooltip. @default String */
  formatValue?: (value: number) => string;
  /** px; the svg scales to the parent width. */
  size?: number;
  /** Ring thickness as a fraction of the radius (0..1). @default 0.32 */
  thickness?: number;
  ariaLabel: string;
  className?: string;
}

const RADIUS = 48;
const CENTER = 50;

export function DonutChart({
  values,
  labels,
  renderTooltipContent,
  formatValue = String,
  size = 160,
  thickness = 0.32,
  ariaLabel,
  className,
}: DonutChartProps) {
  const { showTooltip, hideTooltip, TooltipPortal, tooltipOpen, tooltipData, containerRef } =
    useChartTooltip();
  const innerRadius = RADIUS * (1 - thickness);
  const data = values.map((value, index) => ({ value, index }));

  return (
    <div
      ref={containerRef}
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={ariaLabel}
      >
        <Pie
          data={data}
          pieValue={(d) => d.value}
          outerRadius={RADIUS}
          innerRadius={innerRadius}
          padAngle={0.005}
        >
          {({ path, arcs }) => (
            <Group top={CENTER} left={CENTER}>
              {arcs.map((arc) => (
                <path
                  key={arc.data.index}
                  d={path(arc) ?? undefined}
                  fill={seriesColor(arc.data.index)}
                  onMouseMove={(e) => {
                    const idx = arc.data.index;
                    const content = renderTooltipContent ? (
                      renderTooltipContent(idx, arc.data.value)
                    ) : (
                      <span className="text-xs leading-tight whitespace-nowrap">
                        {labels?.[idx] ? `${labels[idx]}: ` : ''}
                        {formatValue(arc.data.value)}
                      </span>
                    );
                    showTooltip({ key: idx, content }, e.clientX, e.clientY);
                  }}
                  onMouseLeave={hideTooltip}
                />
              ))}
            </Group>
          )}
        </Pie>
      </svg>
      <TooltipPortal>{tooltipOpen ? tooltipData?.content : null}</TooltipPortal>
    </div>
  );
}
