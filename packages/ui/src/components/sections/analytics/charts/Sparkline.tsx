import { LinePath } from '@visx/shape';
import { cn } from '@/lib/utils';
import { computeSparklinePoints } from './geometry';

interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  tone?: 'up' | 'down' | 'neutral';
  className?: string;
}

const TONE_CLASS = {
  up: 'text-[var(--status-success)]',
  down: 'text-[var(--status-error)]',
  neutral: 'text-muted-foreground',
} as const;

export function Sparkline({
  values,
  width = 56,
  height = 20,
  tone = 'neutral',
  className,
}: SparklineProps) {
  const points = computeSparklinePoints(values, width, height);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={cn(TONE_CLASS[tone], className)}
    >
      {points.length >= 2 ? (
        <LinePath
          data={points}
          x={(d) => d.x}
          y={(d) => d.y}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="none"
        />
      ) : null}
    </svg>
  );
}
