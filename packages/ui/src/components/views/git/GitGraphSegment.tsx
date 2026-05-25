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

  return (
    <svg
      width={width}
      height="100%"
      style={{ minHeight: ROW_HEADER_HEIGHT, display: 'block', flexShrink: 0 }}
      aria-hidden
    >
      {connectors.map((seg, idx) => {
        const x1 = seg.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
        const x2 = seg.toLane * LANE_WIDTH + LANE_WIDTH / 2;

        switch (seg.type) {
          case 'passing':
          case 'commit-lane':
            // Full-height vertical line
            return (
              <line key={idx} x1={x1} y1={0} x2={x1} y2={ROW_HEADER_HEIGHT} stroke={seg.color} strokeWidth={2} />
            );

          case 'top-stub':
            // Line from top to dot center only (branch HEAD or root)
            return (
              <line key={idx} x1={x1} y1={0} x2={x1} y2={dotCy} stroke={seg.color} strokeWidth={2} />
            );

          case 'bottom-stub':
            // Line from dot center to bottom only
            return (
              <line key={idx} x1={x1} y1={dotCy} x2={x1} y2={ROW_HEADER_HEIGHT} stroke={seg.color} strokeWidth={2} />
            );

          case 'branch-out':
            // Bezier from dot position to target lane at bottom
            return (
              <path
                key={idx}
                d={`M ${dotCx} ${dotCy} C ${dotCx} ${dotCy + ROW_HEADER_HEIGHT * 0.6}, ${x2} ${dotCy + ROW_HEADER_HEIGHT * 0.4}, ${x2} ${ROW_HEADER_HEIGHT}`}
                fill="none"
                stroke={seg.color}
                strokeWidth={2}
              />
            );

          case 'merge-in':
            // Bezier from top of source lane to dot position
            return (
              <path
                key={idx}
                d={`M ${x1} 0 C ${x1} ${dotCy * 0.6}, ${dotCx} ${dotCy * 0.4}, ${dotCx} ${dotCy}`}
                fill="none"
                stroke={seg.color}
                strokeWidth={2}
              />
            );

          default:
            return null;
        }
      })}

      {/* Commit dot — drawn last so it sits on top of lines */}
      <circle
        cx={dotCx}
        cy={dotCy}
        r={4}
        fill={color}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    </svg>
  );
};
