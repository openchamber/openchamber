import React from 'react';
import type { LanedCommit } from './gitGraph';

export const LANE_WIDTH = 16;
// Fallback used on first render before ResizeObserver fires.
// Typical row (no badges): py-2 (16px) + ui-label line (21px) + meta line (21px) = 58px.
// Rows with many ref badges can be 80–95px; ResizeObserver corrects automatically.
export const ROW_HEADER_HEIGHT = 58;

interface GitGraphSegmentProps {
  laned: LanedCommit;
  /** Total number of active lanes at this point in the graph */
  totalLanes: number;
  /** Whether this commit row is currently expanded */
  isExpanded: boolean;
}

/**
 * Renders the graph SVG column for a single commit row.
 *
 * A ResizeObserver on the container div tracks the actual rendered row height
 * (which varies with ref-badge count, font scale, and expanded state) and feeds
 * it to the SVG so lines and bezier curves always span the full row — no gaps
 * between adjacent rows.
 */
export const GitGraphSegment: React.FC<GitGraphSegmentProps> = ({
  laned,
  totalLanes,
}) => {
  const { lane, color, connectors } = laned;
  const effectiveLanes = Math.max(totalLanes, lane + 1);
  const width = effectiveLanes * LANE_WIDTH + LANE_WIDTH / 2;

  const [svgHeight, setSvgHeight] = React.useState(ROW_HEADER_HEIGHT);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (entry) {
        const h = Math.round(entry.contentRect.height);
        if (h > 0) setSvgHeight(h);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const dotCy = svgHeight / 2;
  const dotCx = lane * LANE_WIDTH + LANE_WIDTH / 2;

  // Render straight lines before bezier curves so curves appear on top
  const sorted = [...connectors].sort((a, b) => {
    const isBezier = (t: string) => t === 'branch-out' || t === 'merge-in';
    return (isBezier(a.type) ? 1 : 0) - (isBezier(b.type) ? 1 : 0);
  });

  return (
    <div
      ref={containerRef}
      style={{ width, height: '100%', flexShrink: 0, display: 'block' }}
    >
      <svg
        width={width}
        height={svgHeight}
        style={{ display: 'block' }}
        aria-hidden
      >
        {sorted.map((seg, idx) => {
          const x1 = seg.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
          const x2 = seg.toLane * LANE_WIDTH + LANE_WIDTH / 2;
          const stroke = {
            stroke: seg.color,
            strokeWidth: 1.5,
            strokeLinecap: 'round' as const,
          };

          switch (seg.type) {
            case 'passing':
            case 'commit-lane':
              return <line key={idx} x1={x1} y1={0} x2={x1} y2={svgHeight} {...stroke} />;

            case 'top-stub':
              return <line key={idx} x1={x1} y1={0} x2={x1} y2={dotCy} {...stroke} />;

            case 'bottom-stub':
              return <line key={idx} x1={x1} y1={dotCy} x2={x1} y2={svgHeight} {...stroke} />;

            case 'branch-out': {
              const mid = (dotCy + svgHeight) / 2;
              return (
                <path key={idx} fill="none"
                  d={`M ${dotCx} ${dotCy} C ${dotCx} ${mid}, ${x2} ${mid}, ${x2} ${svgHeight}`}
                  {...stroke}
                />
              );
            }

            case 'merge-in': {
              const mid = dotCy / 2;
              return (
                <path key={idx} fill="none"
                  d={`M ${x1} 0 C ${x1} ${mid}, ${dotCx} ${mid}, ${dotCx} ${dotCy}`}
                  {...stroke}
                />
              );
            }

            default:
              return null;
          }
        })}

        {/* Dot drawn last so it sits on top of all lines */}
        <circle
          cx={dotCx}
          cy={dotCy}
          r={4}
          fill={color}
          stroke="var(--background)"
          strokeWidth={2}
        />
      </svg>
    </div>
  );
};
