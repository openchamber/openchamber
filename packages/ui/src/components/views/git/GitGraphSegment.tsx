import React from 'react';
import type { LanedCommit } from './gitGraph';

export const LANE_WIDTH = 16;
export const ROW_HEADER_HEIGHT = 58; // initial canvas height before first paint

interface GitGraphSegmentProps {
  laned: LanedCommit;
  totalLanes: number;
  isExpanded: boolean;
}

/**
 * Renders the git graph lane column using an HTML Canvas element.
 *
 * Canvas avoids all SVG viewport/viewBox scaling issues:
 * - CSS `height: 100%` fills the self-stretch container (= actual row height)
 * - useLayoutEffect reads canvas.offsetHeight after layout and draws in real pixels
 * - devicePixelRatio is applied for crisp HiDPI rendering
 * - CSS variables are resolved via getComputedStyle on the canvas element
 */
export const GitGraphSegment: React.FC<GitGraphSegmentProps> = ({
  laned,
  totalLanes,
}) => {
  const { lane, color, connectors } = laned;
  const effectiveLanes = Math.max(totalLanes, lane + 1);
  const w = effectiveLanes * LANE_WIDTH + LANE_WIDTH / 2;

  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  // useLayoutEffect: runs synchronously after DOM layout, before browser paint.
  // At this point canvas.offsetHeight reflects the actual rendered row height.
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const h = canvas.offsetHeight;
    if (h === 0) return;

    // Match canvas buffer size to CSS size × DPR for crisp rendering
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const dotCy = h / 2;
    const dotCx = lane * LANE_WIDTH + LANE_WIDTH / 2;

    // Helper: resolve a CSS variable (e.g. "var(--chart-1)") to a real color string.
    // Canvas strokeStyle / fillStyle do not understand CSS variables natively.
    const resolveColor = (value: string): string => {
      if (!value.startsWith('var(')) return value;
      const varName = value.slice(4, -1).trim(); // strip 'var(' and ')'
      return getComputedStyle(canvas).getPropertyValue(varName).trim() || '#888888';
    };

    // Draw straight lines first, then bezier curves on top, then the dot last.
    const sorted = [...connectors].sort((a, b) => {
      const isBezier = (t: string) => t === 'branch-out' || t === 'merge-in';
      return (isBezier(a.type) ? 1 : 0) - (isBezier(b.type) ? 1 : 0);
    });

    for (const seg of sorted) {
      const x1 = seg.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
      const x2 = seg.toLane * LANE_WIDTH + LANE_WIDTH / 2;

      ctx.beginPath();
      ctx.strokeStyle = resolveColor(seg.color);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';

      switch (seg.type) {
        case 'passing':
        case 'commit-lane':
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, h);
          break;

        case 'top-stub':
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, dotCy);
          break;

        case 'bottom-stub':
          ctx.moveTo(x1, dotCy);
          ctx.lineTo(x1, h);
          break;

        case 'branch-out': {
          const mid = (dotCy + h) / 2;
          ctx.moveTo(dotCx, dotCy);
          ctx.bezierCurveTo(dotCx, mid, x2, mid, x2, h);
          break;
        }

        case 'merge-in': {
          const mid = dotCy / 2;
          ctx.moveTo(x1, 0);
          ctx.bezierCurveTo(x1, mid, dotCx, mid, dotCx, dotCy);
          break;
        }

        default:
          continue;
      }

      ctx.stroke();
    }

    // Commit dot — drawn last, always on top
    const bgColor = getComputedStyle(canvas).getPropertyValue('--background').trim() || '#000000';
    ctx.beginPath();
    ctx.arc(dotCx, dotCy, 4, 0, Math.PI * 2);
    ctx.fillStyle = resolveColor(color);
    ctx.fill();
    // Ring punches through overlapping lane lines, isolating the dot visually
    ctx.beginPath();
    ctx.arc(dotCx, dotCy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = bgColor.startsWith('#') || bgColor.startsWith('rgb') ? bgColor : `#${bgColor}`;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  return (
    <canvas
      ref={canvasRef}
      // CSS width fixed; CSS height fills the self-stretch wrapper = actual row height
      style={{ width: w, height: '100%', display: 'block', flexShrink: 0 }}
    />
  );
};
