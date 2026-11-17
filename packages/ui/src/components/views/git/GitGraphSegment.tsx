import React from 'react';
import type { LanedCommit } from './gitGraph';

const LANE_WIDTH = 8;

interface GitGraphSegmentProps {
  laned: LanedCommit;
  totalLanes: number;
  isExpanded: boolean;
}

export const GitGraphSegment: React.FC<GitGraphSegmentProps> = ({
  laned,
  totalLanes,
  isExpanded,
}) => {
  const { lane, color, connectors } = laned;
  const effectiveLanes = Math.max(totalLanes, lane + 1);
  const w = effectiveLanes * LANE_WIDTH + LANE_WIDTH / 2;

  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const h = container.offsetHeight;
    if (h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const dotCy = h / 2;
    const dotCx = lane * LANE_WIDTH + LANE_WIDTH / 2;

    const styles = getComputedStyle(canvas);
    const fallbackColor = styles.getPropertyValue('--surface-muted-foreground').trim() || styles.color;

    const resolveColor = (value: string): string => {
      if (!value.startsWith('var(')) return value;
      const varName = value.slice(4, -1).trim();
      return styles.getPropertyValue(varName).trim() || fallbackColor;
    };

    const sorted = [...connectors].sort((a, b) => {
      const isBezier = (t: string) => t === 'branch-out' || t === 'merge-in';
      return (isBezier(a.type) ? 1 : 0) - (isBezier(b.type) ? 1 : 0);
    });

    for (const seg of sorted) {
      const x1 = seg.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
      const x2 = seg.toLane * LANE_WIDTH + LANE_WIDTH / 2;
      const lineAlpha = seg.type === 'passing'
        ? 0.72
        : seg.type === 'branch-out' || seg.type === 'merge-in'
          ? 0.95
          : 1;

      ctx.beginPath();
      ctx.strokeStyle = resolveColor(seg.color);
      ctx.globalAlpha = lineAlpha;
      ctx.lineWidth = 1.25;
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
      ctx.globalAlpha = 1;
    }

    const bg = styles.getPropertyValue('--background').trim() || styles.getPropertyValue('--surface-background').trim();
    ctx.beginPath();
    ctx.arc(dotCx, dotCy, 4, 0, Math.PI * 2);
    ctx.fillStyle = resolveColor(color);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotCx, dotCy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = bg || fallbackColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [laned, lane, color, connectors, totalLanes, isExpanded, w]);

  return (
    <div
      ref={containerRef}
      style={{ width: w, height: '100%', position: 'relative', flexShrink: 0, overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
};
