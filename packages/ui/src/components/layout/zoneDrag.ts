import { create } from 'zustand';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { computeCenterDropTargets, computeZoneDropFrames, computeZoneDropTargets, hitTestZoneDropTargets, type ZoneDropTargets, type ZonePoint, type ZoneRect } from '@/lib/workspace/zoneDropTargets';
import { shownContextModes, type ContextZone } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { isRightToLeft } from '@/lib/i18n';

type ActiveZoneDrag = {
  mode: ContextPanelMode;
  label: string;
  from: ContextZone;
  targets: ZoneDropTargets;
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

const openZoneCard = (zone: ContextZone): ZoneRect | null => (
  rectOf(document.querySelector(`[data-context-zone="${zone}"][data-context-panel-open="true"] [data-zone-card]`))
);

export const beginZoneDrag = (drag: Omit<ActiveZoneDrag, 'targets' | 'frames'>): boolean => {
  const rowElement = document.querySelector('[data-workspace-row]');
  const row = rectOf(rowElement);
  const chatColumn = rectOf(document.querySelector('[data-workspace-chat]'));
  if (!rowElement || !row || !chatColumn) return false;
  const bottomZone = document.querySelector('[data-context-zone="bottom"][data-context-panel-open="true"]');
  const measured = document.querySelector('[data-workspace-center]')
    ? computeCenterDropTargets(row, chatColumn)
    : computeZoneDropTargets(row, chatColumn, rectOf(bottomZone));
  const targets = isRightToLeft(rowElement) ? { ...measured, left: measured.right, right: measured.left } : measured;
  const frames = computeZoneDropFrames(targets, {
    left: openZoneCard('left'),
    right: openZoneCard('right'),
    bottom: openZoneCard('bottom'),
  });
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
  finish: (directory: string | null | undefined) => boolean;
  cancel: () => void;
};

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
