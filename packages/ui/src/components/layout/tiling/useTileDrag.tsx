import React from 'react';
import {
  DndContext,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import { useUIStore } from '@/stores/useUIStore';
import { resolveTileDrop, type TileDropTarget } from './resolveTileDrop';
import { TileDragContext, type TileDragState } from './tileDragContext';
import type { PanelLayout, SplitAnchor } from './splitTree';

const SPLIT_ANCHORS: readonly SplitAnchor[] = ['left', 'right', 'top', 'bottom'];

const isSplitAnchor = (value: unknown): value is SplitAnchor =>
  typeof value === 'string' && (SPLIT_ANCHORS as readonly string[]).includes(value);

// Reads a dnd-kit `over` node's data into the pure drop-decision shape. Returns
// null for unknown targets so a drop over anything unrecognized is a no-op.
const toDropTarget = (data: Record<string, unknown> | undefined): TileDropTarget | null => {
  if (!data || typeof data.groupId !== 'string') return null;
  const groupId = data.groupId;
  switch (data.type) {
    case 'anchor':
      return isSplitAnchor(data.anchor) ? { kind: 'anchor', groupId, anchor: data.anchor } : null;
    case 'strip':
      return { kind: 'strip', groupId };
    case 'tab':
      return typeof data.tileId === 'string' && typeof data.index === 'number'
        ? { kind: 'tab', groupId, tileId: data.tileId, index: data.index }
        : null;
    default:
      return null;
  }
};

type TileDragProviderProps = {
  directoryKey: string;
  layout: PanelLayout | null;
  children: React.ReactNode;
};

export const TileDragProvider: React.FC<TileDragProviderProps> = ({ directoryKey, layout, children }) => {
  const [activeTileId, setActiveTileId] = React.useState<string | null>(null);
  const splitTileIntoNewRegion = useUIStore((state) => state.splitTileIntoNewRegion);
  const moveTileToRegion = useUIStore((state) => state.moveTileToRegion);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveTileId(String(event.active.id));
  }, []);

  const handleDragCancel = React.useCallback(() => {
    setActiveTileId(null);
  }, []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    setActiveTileId(null);
    if (!directoryKey || !layout) return;

    const tileId = String(event.active.id);
    const activeData = event.active.data.current as Record<string, unknown> | undefined;
    const activeGroupId = typeof activeData?.groupId === 'string' ? activeData.groupId : null;
    if (!activeGroupId) return;

    const over = toDropTarget(event.over?.data.current as Record<string, unknown> | undefined);
    const result = resolveTileDrop({ activeTileId: tileId, activeGroupId, over });
    if (!result) return;

    switch (result.kind) {
      case 'split':
        splitTileIntoNewRegion(directoryKey, result.groupId, tileId, result.anchor);
        return;
      case 'move':
        moveTileToRegion(directoryKey, tileId, result.groupId, result.index);
        return;
      case 'reorder':
        reorderContextPanelTabs(directoryKey, tileId, result.overTileId);
        return;
    }
  }, [directoryKey, layout, moveTileToRegion, reorderContextPanelTabs, splitTileIntoNewRegion]);

  const contextValue = React.useMemo<TileDragState>(() => ({ activeTileId }), [activeTileId]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <TileDragContext.Provider value={contextValue}>{children}</TileDragContext.Provider>
    </DndContext>
  );
};
