import React from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from "@/components/icon/Icon";
import { getSessionFolderIdentityKey, isArchivedFolderScope } from '../sessions/sessionFolderIdentity';

type SessionFolderDropTarget = {
  folderId: string;
  scopeKey: string;
  ownerKey: string;
};

export const DraggableSessionRow: React.FC<{
  sessionId: string;
  dragKey?: string;
  ownerKey?: string | null;
  sessionDirectory: string | null;
  sessionTitle: string;
  archivedBucket?: boolean;
  children: React.ReactNode;
}> = ({ sessionId, dragKey, ownerKey = null, sessionDirectory, sessionTitle, archivedBucket = false, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session-drag:${dragKey ?? sessionId}`,
    disabled: archivedBucket,
    data: { type: 'session', sessionId, ownerKey, sessionDirectory, sessionTitle, archivedBucket },
  });

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (listeners?.onPointerDown) {
        // SAFETY: dnd-kit registers a React pointer listener for this draggable handle.
        (listeners.onPointerDown as (event: React.PointerEvent) => void)(e);
      }
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onPointerDown={handlePointerDown}
      className={`touch-pan-y select-none${isDragging ? ' opacity-30' : ''}`}
    >
      {children}
    </div>
  );
};

export const DroppableFolderWrapper: React.FC<{
  folderId: string;
  scopeKey: string;
  ownerKey: string | null;
  disabled?: boolean;
  children: (
    droppableRef: (node: HTMLElement | null) => void,
    isOver: boolean,
  ) => React.ReactNode;
}> = ({ folderId, scopeKey, ownerKey, disabled = false, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-drop:${getSessionFolderIdentityKey(scopeKey, folderId)}`,
    disabled: disabled || isArchivedFolderScope(scopeKey),
    data: { type: 'folder', folderId, scopeKey, ownerKey },
  });
  return <>{children(setNodeRef, isOver)}</>;
};

export const SessionFolderDndScope: React.FC<{
  scopeKey: string | null;
  ownerKey?: string | null;
  hasFolders: boolean;
  onSessionDroppedOnFolder: (sessionId: string, target: SessionFolderDropTarget, sourceOwnerKey: string) => void;
  children: React.ReactNode;
}> = ({ scopeKey, ownerKey = null, hasFolders, onSessionDroppedOnFolder, children }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  const [activeDragTitle, setActiveDragTitle] = React.useState<string>('Session');
  const [activeDragWidth, setActiveDragWidth] = React.useState<number | null>(null);
  const [activeDragHeight, setActiveDragHeight] = React.useState<number | null>(null);

  if (!scopeKey) {
    return <>{children}</>;
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    const { active, over } = event;
    if (!over) return;
    // SAFETY: both payloads are created by the draggable and droppable components in this module.
    const activeData = active.data.current as { type?: string; sessionId?: string; ownerKey?: string | null; archivedBucket?: boolean } | undefined;
    // SAFETY: both payloads are created by the draggable and droppable components in this module.
    const overData = over.data.current as { type?: string; folderId?: string; scopeKey?: string; ownerKey?: string | null } | undefined;
    if (
      activeData?.type !== 'session'
      || !activeData.sessionId
      || !activeData.ownerKey
      || activeData.archivedBucket === true
      || (ownerKey && activeData.ownerKey !== ownerKey)
      || overData?.type !== 'folder'
      || !overData.folderId
      || !overData.scopeKey
      || !overData.ownerKey
      || isArchivedFolderScope(overData.scopeKey)
      || overData.ownerKey !== activeData.ownerKey
    ) return;
    onSessionDroppedOnFolder(activeData.sessionId, {
      folderId: overData.folderId,
      scopeKey: overData.scopeKey,
      ownerKey: overData.ownerKey,
    }, activeData.ownerKey);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => {
        // SAFETY: drag payloads are created by DraggableSessionRow in this module.
        const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string } | undefined;
        if (data?.type === 'session' && data.sessionId) {
          setActiveDragId(data.sessionId);
          setActiveDragTitle(data.sessionTitle ?? 'Session');
          const width = event.active.rect.current.initial?.width;
          const height = event.active.rect.current.initial?.height;
          setActiveDragWidth(width ?? null);
          setActiveDragHeight(height ?? null);
        }
      }}
      onDragCancel={() => {
        setActiveDragId(null);
        setActiveDragWidth(null);
        setActiveDragHeight(null);
      }}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay>
        {activeDragId && hasFolders ? (
          <div
            style={{
              width: activeDragWidth ? `${activeDragWidth}px` : 'auto',
              height: activeDragHeight ? `${activeDragHeight}px` : 'auto',
            }}
            className="flex items-center rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1 shadow-none pointer-events-none"
          >
            <Icon name="sticky-note" className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
            <div className="min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">
              {activeDragTitle}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
