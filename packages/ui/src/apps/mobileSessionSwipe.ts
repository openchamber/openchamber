export type SwipeAxis = 'undecided' | 'vertical' | 'horizontal';

type SwipeMove =
  | { type: 'cancel' }
  | { type: 'ignore'; axis: SwipeAxis }
  | { type: 'drag'; axis: 'horizontal'; offset: number };

export const resolveSwipeMove = ({
  touchCount,
  dx,
  dy,
  axis,
  dragging,
  revealed,
  actionsWidth,
}: {
  touchCount: number;
  dx: number;
  dy: number;
  axis: SwipeAxis;
  dragging: boolean;
  revealed: boolean;
  actionsWidth: number;
}): SwipeMove => {
  if (touchCount !== 1) return { type: 'cancel' };
  if (axis === 'vertical') return { type: 'ignore', axis };

  if (!dragging) {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (Math.max(absDx, absDy) < 8) return { type: 'ignore', axis };
    if (absDy >= absDx) return { type: 'ignore', axis: 'vertical' };
  }

  const base = revealed ? -actionsWidth : 0;
  return {
    type: 'drag',
    axis: 'horizontal',
    offset: Math.min(0, Math.max(-actionsWidth, base + dx)),
  };
};
