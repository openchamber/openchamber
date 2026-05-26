import React from 'react';
import type { LanedCommit } from './gitGraph';

export const LANE_WIDTH = 16;
export const ROW_HEADER_HEIGHT = 40; // px — must match the commit row header height

interface GitGraphSegmentProps {
  laned: LanedCommit;
  /** Total number of active lanes at this point in the graph */
  totalLanes: number;
  /** Whether this commit row is currently expanded */
  isExpanded: boolean;
}

/**
 * Renders the graph SVG column for a single commit row.
 * Each ConnectorSegment covers the full row height — no separate stubs needed.
 */
export const GitGraphSegment: React.FC<GitGraphSegmentProps> = ({
  laned,
  totalLanes,
}) => {
  const { lane, color, connectors } = laned;
  const effectiveLanes = Math.max(totalLanes, lane + 1);
  const width = effectiveLanes * LANE_WIDTH + LANE_WIDTH / 2;
  const dotCy = ROW_HEADER_HEIGHT / 2;
  const dotCx = lane * LANE_WIDTH + LANE_WIDTH / 2;

  // Render straight lines before bezier curves so curves appear on top
  const sorted = [...connectors].sort((a, b) => {
    const isBezier = (t: string) => t === 'branch-out' || t === 'merge-in';
    return (isBezier(a.type) ? 1 : 0) - (isBezier(b.type) ? 1 : 0);
  });

  return (
    <svg
      width={width}
      viewBox={`0 0 ${width} ${ROW_HEADER_HEIGHT}`}
      preserveAspectRatio="none"
      style={{ height: '100%', display: 'block', flexShrink: 0 }}
      aria-hidden
    >
      {sorted.map((seg, idx) => {
        const x1 = seg.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
        const x2 = seg.toLane * LANE_WIDTH + LANE_WIDTH / 2;
        // vectorEffect="non-scaling-stroke" keeps strokeWidth in screen pixels
        // regardless of the non-uniform viewBox scale — prevents elliptical-pen artifacts
        const stroke = {
          stroke: seg.color,
          strokeWidth: 1.5,
          strokeLinecap: 'round' as const,
          vectorEffect: 'non-scaling-stroke' as const,
        };

        switch (seg.type) {
          case 'passing':
          case 'commit-lane':
            return <line key={idx} x1={x1} y1={0} x2={x1} y2={ROW_HEADER_HEIGHT} {...stroke} />;

          case 'top-stub':
            return <line key={idx} x1={x1} y1={0} x2={x1} y2={dotCy} {...stroke} />;

          case 'bottom-stub':
            return <line key={idx} x1={x1} y1={dotCy} x2={x1} y2={ROW_HEADER_HEIGHT} {...stroke} />;

          case 'branch-out': {
            const mid = (dotCy + ROW_HEADER_HEIGHT) / 2;
            return (
              <path key={idx} fill="none"
                d={`M ${dotCx} ${dotCy} C ${dotCx} ${mid}, ${x2} ${mid}, ${x2} ${ROW_HEADER_HEIGHT}`}
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

      {/* Dot drawn last — always on top; vectorEffect keeps the halo ring circular */}
      <circle
        cx={dotCx} cy={dotCy} r={4}
        fill={color}
        stroke="var(--background)" strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};
