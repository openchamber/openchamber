import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brush, type Bounds } from '@visx/brush';
import type { BrushHandleRenderProps } from '@visx/brush';
import { scaleLinear } from '@visx/scale';
import { Group } from '@visx/group';
import { useContainerWidth } from './useContainerWidth';

interface BrushableTimeSeriesProps<D> {
  data: readonly D[];
  /** Render the main chart for a (filtered) slice of data. */
  renderInner: (args: { data: readonly D[]; width: number; height: number }) => ReactNode;
  /** Render the overview chart preview as SVG elements (full data, no tooltips). */
  renderOverview: (args: { data: readonly D[]; width: number; height: number }) => ReactNode;
  /** Main chart height. @default 180 */
  height?: number;
  /** Day count above which the brush overview appears. @default 30 */
  threshold?: number;
}

/** The brush overview strip is always 24px tall. */
const BRUSH_HEIGHT = 24;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/** Visible brush handle (adapted from the visx docs example). */
function BrushHandle({ x, height, isBrushActive }: BrushHandleRenderProps) {
  const pathHeight = 15;
  if (!isBrushActive) return null;
  return (
    <Group left={x+3} top={(height - pathHeight) / 2}>
      <path
        fill="var(--popover)"
        stroke="var(--chart-1)"
        strokeWidth={1}
        d="M -3 0 L 3 0 L 3 15 L -3 15 L -3 0 M -1 3 L -1 12 M 1 3 L 1 12"
        style={{ cursor: 'ew-resize' }}
      />
    </Group>
  );
}

export function BrushableTimeSeries<D>({
  data,
  renderInner,
  renderOverview,
  height = 180,
  threshold = 30,
}: BrushableTimeSeriesProps<D>) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const showBrush = data.length > threshold;

  const [visible, setVisible] = useState<[number, number]>(() => {
    const start = Math.max(0, data.length - threshold);
    return [start, data.length];
  });

  useEffect(() => {
    const start = Math.max(0, data.length - threshold);
    setVisible([start, data.length]);
  }, [data.length, threshold]);

  const overviewX = useMemo(
    () => scaleLinear<number>({ domain: [0, Math.max(data.length, 1)], range: [0, Math.max(width, 1)] }),
    [data.length, width],
  );
  const overviewY = useMemo(
    () => scaleLinear<number>({ domain: [0, 1], range: [BRUSH_HEIGHT, 0] }),
    [],
  );

  // Brush.onChange passes DOMAIN values (already inverted via the brush xScale),
  // so bounds.x0/x1 are indices into [0, data.length] — use them directly.
  const onChange = (bounds: Bounds | null) => {
    if (!bounds || width <= 0) return;
    const start = clamp(Math.floor(bounds.x0), 0, data.length);
    const end = clamp(Math.ceil(bounds.x1), start + 1, data.length);
    setVisible([start, end]);
  };

  const [visStart, visEnd] = visible;
  const visibleData = data.slice(visStart, visEnd);

  const initialBrushPosition = useMemo(() => {
    const start = Math.max(0, data.length - threshold);
    return {
      start: { x: overviewX(start) },
      end: { x: overviewX(data.length) },
    };
  }, [data.length, threshold, overviewX]);

  return (
    // No computed absolute height: the wrapper flows to its content. Width is
    // measured from the parent (useContainerWidth). The brush is always h-8.
    <div ref={ref} className="flex w-full flex-col gap-3 select-none">
      <div style={{ height }}>
        {width > 0 && renderInner({ data: visibleData, width, height })}
      </div>
      {showBrush && width > 0 && (
        <svg
          width={width}
          height={BRUSH_HEIGHT}
          className="w-full overflow-visible"
          style={{ display: 'block' }}
          aria-hidden
        >
          {renderOverview({ data, width, height: BRUSH_HEIGHT })}
          <Brush
            key={data.length}
            xScale={overviewX}
            yScale={overviewY}
            width={width}
            height={BRUSH_HEIGHT}
            handleSize={8}
            resizeTriggerAreas={['left', 'right']}
            brushDirection="horizontal"
            onChange={onChange}
            initialBrushPosition={initialBrushPosition}
            useWindowMoveEvents
            renderBrushHandle={(props) => <BrushHandle {...props} />}
            selectedBoxStyle={{
              fill: 'var(--chart-1)',
              fillOpacity: 0.12,
              stroke: 'var(--chart-1)',
              strokeWidth: 1,
              strokeOpacity: 0.6,
            }}
          />
        </svg>
      )}
    </div>
  );
}
