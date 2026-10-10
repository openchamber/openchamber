import { create } from 'zustand';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { computeZoneDropTargets, hitTestZoneDropTargets, type ZoneDropTargets, type ZonePoint, type ZoneRect } from '@/lib/workspace/zoneDropTargets';
import { shownContextModes, type ContextZone } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/**
 * Moving a surface to another zone by dragging it: a rail icon, a panel tab
 * or a panel header. The targets are measured once when the drag starts and
 * only the hovered one changes while it runs; nothing reflows until the drop,
 * which moves the surface once (`moveContextSurfaceToZone`).
 */
type ActiveZoneDrag = {
  mode: ContextPanelMode;
  label: string;
  /** Where the surface lives now. */
  from: ContextZone;
  targets: ZoneDropTargets;
  /** Where each target is drawn: the open card it stands for, else its area inset like a card. */
  frames: ZoneDropTargets;
};

type ZoneDragState = {
  drag: ActiveZoneDrag | null;
  hovered: ContextZone | null;
};

export const useZoneDragStore = create<ZoneDragState>(() => ({ drag: null, hovered: null }));

const rectOf = (element: Element | null): ZoneRect | null => {
  if (!element) return null;
  const { left, top, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { left, top, width, height } : null;
};

// The gutters zone cards keep from their surroundings: none above (cards
// start at the top of the workspace), 6 px beside, 8 px below.
const insetLikeCard = (rect: ZoneRect): ZoneRect => ({
  left: rect.left + 6,
  top: rect.top,
  width: Math.max(0, rect.width - 12),
  height: Math.max(0, rect.height - 8),
});

const openZoneCard = (zone: ContextZone): ZoneRect | null => (
  rectOf(document.querySelector(`[data-context-zone="${zone}"][data-context-panel-open="true"] [data-zone-card]`))
);

/** Shows the drop targets. False when the layout has no workspace to drop into. */
export const beginZoneDrag = (drag: Omit<ActiveZoneDrag, 'targets' | 'frames'>): boolean => {
  const row = rectOf(document.querySelector('[data-workspace-row]'));
  const chatColumn = rectOf(document.querySelector('[data-workspace-chat]'));
  if (!row || !chatColumn) return false;
  // The bottom zone's aside, card and gutters: the whole band it holds.
  const bottomZone = document.querySelector('[data-context-zone="bottom"][data-context-panel-open="true"]');
  const targets = computeZoneDropTargets(row, chatColumn, rectOf(bottomZone));
  const frames = {
    left: openZoneCard('left') ?? insetLikeCard(targets.left),
    right: openZoneCard('right') ?? insetLikeCard(targets.right),
    bottom: openZoneCard('bottom') ?? insetLikeCard(targets.bottom),
  };
  useZoneDragStore.setState({ drag: { ...drag, targets, frames }, hovered: null });
  return true;
};

export const updateZoneDrag = (point: ZonePoint): void => {
  const { drag, hovered } = useZoneDragStore.getState();
  if (!drag) return;
  const next = hitTestZoneDropTargets(drag.targets, point);
  if (next !== hovered) useZoneDragStore.setState({ hovered: next });
};

export const cancelZoneDrag = (): void => {
  if (useZoneDragStore.getState().drag) useZoneDragStore.setState({ drag: null, hovered: null });
};

/**
 * Drops the surface on the hovered target: it moves there (when it was
 * elsewhere) and is on screen afterwards. Returns whether it landed on a
 * target, so a source can skip what the gesture would otherwise do.
 */
export const finishZoneDrag = (directory: string | null | undefined): boolean => {
  const { drag, hovered } = useZoneDragStore.getState();
  useZoneDragStore.setState({ drag: null, hovered: null });
  if (!drag || !hovered) return false;
  const ui = useUIStore.getState();
  if (hovered !== drag.from) ui.moveContextSurfaceToZone(drag.mode, hovered);
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  if (directoryKey) {
    const after = useUIStore.getState();
    if (!shownContextModes(after.contextPanelByDirectory[directoryKey], after.contextSurfaceZones).has(drag.mode)) {
      after.openContextSurface(directoryKey, drag.mode);
    }
  }
  return true;
};

export type ZoneDragGesture = {
  /**
   * Ends the gesture. True when it ended outside the source: the drop was
   * the zone drag's, on a target or not, and the source does nothing more.
   */
  finish: (directory: string | null | undefined) => boolean;
  cancel: () => void;
};

/**
 * Follows a drag a source already runs (a sortable rail icon or tab). The
 * targets show once the pointer leaves the source (`isOutside`), and hide
 * again when it comes back, so a drag that stays inside keeps its own meaning
 * (reordering).
 */
export const startZoneDragGesture = (
  drag: Omit<ActiveZoneDrag, 'targets' | 'frames'>,
  isOutside: (point: ZonePoint) => boolean,
): ZoneDragGesture => {
  let active = false;
  const onMove = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    if (isOutside(point)) {
      if (!active) active = beginZoneDrag(drag);
      if (active) updateZoneDrag(point);
    } else if (active) {
      cancelZoneDrag();
      active = false;
    }
  };
  window.addEventListener('pointermove', onMove);
  const stop = () => window.removeEventListener('pointermove', onMove);
  return {
    finish: (directory) => {
      stop();
      if (!active) return false;
      finishZoneDrag(directory);
      return true;
    },
    cancel: () => {
      stop();
      if (active) cancelZoneDrag();
    },
  };
};
