// external: #2368 Chromium micro-drags suppress the click that should open or toggle a file-tree row.

// external: #2368 The click-recovery slop absorbs pointer wobble after Chromium starts a native drag.
const DRAG_CLICK_SLOP_PX = 8;

type DragPointerEvent = {
  clientX: number;
  clientY: number;
};

let pendingDragOrigin: { x: number; y: number } | null = null;

const isWithinSlop = (origin: { x: number; y: number }, event: DragPointerEvent): boolean => (
  Math.abs(event.clientX - origin.x) <= DRAG_CLICK_SLOP_PX
  && Math.abs(event.clientY - origin.y) <= DRAG_CLICK_SLOP_PX
);

export const recordFileTreeDragStart = (event: DragPointerEvent): void => {
  pendingDragOrigin = { x: event.clientX, y: event.clientY };
};

export const shouldTreatFileTreeDragEndAsClick = (
  event: DragPointerEvent & { dataTransfer: { dropEffect: string } | null },
): boolean => {
  const origin = pendingDragOrigin;
  pendingDragOrigin = null;
  if (!origin) return false;
  if (event.dataTransfer && event.dataTransfer.dropEffect !== 'none') return false;
  return isWithinSlop(origin, event);
};

export const isFileTreeDragWithinClickSlop = (event: DragPointerEvent): boolean => {
  return pendingDragOrigin !== null && isWithinSlop(pendingDragOrigin, event);
};

export const resetFileTreeDragClickState = (): void => {
  pendingDragOrigin = null;
};
