/**
 * Click-reliability fallback for file tree rows that are both clickable and
 * draggable (issue #2368).
 *
 * A native HTML5 drag starts after only a few pixels of pointer travel
 * (4px in Chromium), and once `dragstart` fires the browser suppresses the
 * `click` event for that gesture entirely. On macOS trackpads and Magic
 * Mouse a plain click very often slips past that threshold, so rows that
 * carry `draggable` (to drag file references into the chat input) randomly
 * ignored clicks: folders neither expanded nor collapsed and files did not
 * open.
 *
 * Arming `draggable` only after a pointer-move threshold is not a fix:
 * Chromium decides drag eligibility on the first mouse move after mousedown
 * and never re-evaluates, so a drag whose first movement stays below the
 * threshold would never start (verified against headless Chromium).
 *
 * Instead the row stays draggable, and a drag that ends where it began —
 * within a small slop radius and without dropping onto any target — is
 * treated as the click it was meant to be. The two paths are mutually
 * exclusive: when the browser suppresses `click` it fired `dragstart`, and
 * when `click` fires no drag ever started, so the row action runs exactly
 * once per gesture.
 *
 * Module-level state is safe here because the platform allows only one
 * native drag at a time.
 */

/**
 * Chromium starts a native drag at 4px of travel, so a suppressed click's
 * dragstart→dragend distance is near zero. The slop only needs to absorb
 * the remaining wobble between drag start and release; a deliberate drag
 * released mid-flight travels far beyond it.
 */
const DRAG_CLICK_SLOP_PX = 8;

type DragPointerEvent = {
  clientX: number;
  clientY: number;
};

let pendingDragOrigin: { x: number; y: number } | null = null;

/** Record where a file row drag started. Call from the row's `dragstart`. */
export const recordFileTreeDragStart = (event: DragPointerEvent): void => {
  pendingDragOrigin = { x: event.clientX, y: event.clientY };
};

/**
 * True when the drag that just ended was an accidental micro-drag that
 * swallowed a click: it was never dropped onto a target and it ended within
 * `DRAG_CLICK_SLOP_PX` of where it started. Consumes the recorded origin.
 */
export const shouldTreatFileTreeDragEndAsClick = (
  event: DragPointerEvent & { dataTransfer: { dropEffect: string } | null },
): boolean => {
  const origin = pendingDragOrigin;
  pendingDragOrigin = null;
  if (!origin) return false;
  if (event.dataTransfer && event.dataTransfer.dropEffect !== 'none') return false;
  return (
    Math.abs(event.clientX - origin.x) <= DRAG_CLICK_SLOP_PX
    && Math.abs(event.clientY - origin.y) <= DRAG_CLICK_SLOP_PX
  );
};

/** Reset module state. Intended for tests. */
export const resetFileTreeDragClickState = (): void => {
  pendingDragOrigin = null;
};
