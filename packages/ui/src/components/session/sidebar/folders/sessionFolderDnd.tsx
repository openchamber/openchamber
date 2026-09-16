import React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from "@/components/icon/Icon";
import { getSessionFolderIdentityKey } from '../sessions/sessionFolderIdentity';
import { isArchivedFolderScope } from '@/lib/sessionFolderIdentity';

export type SessionFolderDropTarget = {
  folderId: string;
  scopeKey: string;
  ownerKey: string;
};

export const DraggableSessionRow: React.FC<{
  sessionId: string;
  /** Optional row occurrence key for lists that can render one session twice. */
  dragKey?: string;
  /** Project id, or the managed-Chats directory owner for this row. */
  ownerKey: string | null;
  sessionDirectory: string | null;
  sessionTitle: string;
  archivedBucket?: boolean;
  children: React.ReactNode;
}> = ({ sessionId, dragKey, ownerKey, sessionDirectory, sessionTitle, archivedBucket = false, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session-drag:${dragKey ?? sessionId}`,
    disabled: archivedBucket,
    data: { type: 'session', sessionId, ownerKey, sessionDirectory, sessionTitle, archivedBucket },
  });

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (listeners?.onPointerDown) {
        // SAFETY: @dnd-kit exposes its pointer listener as a generic synthetic listener;
        // this branch is only reached for the pointer sensor listener.
        (listeners.onPointerDown as (event: React.PointerEvent) => void)(e);
      }
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      onPointerDown={handlePointerDown}
      className={isDragging ? 'opacity-30' : undefined}
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
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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
    // SAFETY: DnD data is written by DraggableSessionRow in this module and is
    // validated by the discriminant/required-field checks below before use.
    const activeData = active.data.current as {
      type?: string;
      sessionId?: string;
      ownerKey?: string | null;
      archivedBucket?: boolean;
    } | undefined;
    // SAFETY: DnD data is written by DroppableFolderWrapper in this module and
    // is validated by the discriminant/required-field checks below before use.
    const overData = over.data.current as {
      type?: string;
      folderId?: string;
      scopeKey?: string;
      ownerKey?: string | null;
    } | undefined;
    if (
      activeData?.type !== 'session'
      || !activeData.sessionId
      || !activeData.ownerKey
      || (ownerKey && activeData.ownerKey !== ownerKey)
      || overData?.type !== 'folder'
      || !overData.folderId
      || !overData.scopeKey
      || !overData.ownerKey
      || activeData.archivedBucket === true
      || isArchivedFolderScope(overData.scopeKey)
      || activeData.ownerKey !== overData.ownerKey
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
        // SAFETY: the active item is created by DraggableSessionRow and the
        // discriminant/required-field checks guard the values used here.
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
