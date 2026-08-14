import React from 'react';

interface DonutSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

interface UsageDonutChartProps {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
  emptyLabel: string;
  ariaLabel: string;
}

const polar = (cx: number, cy: number, radius: number, angle: number) => {
  const rad = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
};

const describeArc = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  const start = polar(cx, cy, radius, endAngle);
  const end = polar(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
};

export const UsageDonutChart: React.FC<UsageDonutChartProps> = ({
  slices,
  centerLabel,
  centerValue,
  emptyLabel,
  ariaLabel,
}) => {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 62;
  const stroke = 18;

  let angle = 0;
  const arcs = slices
    .filter((slice) => slice.value > 0)
    .map((slice) => {
      const portion = total <= 0 ? 0 : (slice.value / total) * 360;
      const start = angle;
      const end = angle + Math.max(portion, portion > 0 ? 0.5 : 0);
      angle = end;
      return { ...slice, start, end };
    });

  return (
    <div className="flex flex-col items-center gap-4" role="img" aria-label={ariaLabel}>
      {total <= 0 ? (
        <div className="flex h-[180px] w-[180px] items-center justify-center rounded-full border border-dashed border-[var(--interactive-border)] typography-meta text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="relative h-[180px] w-[180px]">
          <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-0">
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="var(--surface-subtle)"
              strokeWidth={stroke}
            />
            {arcs.map((arc) => (
              <path
                key={arc.id}
                d={describeArc(cx, cy, radius, arc.start, arc.end)}
                fill="none"
                stroke={arc.color}
                strokeWidth={stroke}
                strokeLinecap="butt"
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="typography-micro text-muted-foreground">{centerLabel}</span>
            <span className="typography-ui-header font-medium text-foreground tabular-nums">{centerValue}</span>
          </div>
        </div>
      )}
    </div>
  );
};
