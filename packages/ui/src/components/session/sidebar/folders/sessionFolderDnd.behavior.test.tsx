import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../test-utils/testDom';

type DragEnd = (event: {
  active: { data: { current: { type: string; sessionId: string } } };
  over: { data: { current: { type: string; folderId: string } } } | null;
}) => void;

let handleDragEnd: DragEnd | null = null;

mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: DragEnd }) => {
    handleDragEnd = onDragEnd;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, isDragging: false }),
  useDroppable: () => ({ setNodeRef: () => undefined, isOver: false }),
}));

const { SessionFolderDndScope } = await import('./sessionFolderDnd');

describe('SessionFolderDndScope public behavior', () => {
  test('routes a session-folder drop without depending on row edit or menu state', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const drops: Array<{ sessionId: string; folderId: string }> = [];

    try {
      await act(async () => root.render(
        <SessionFolderDndScope
          scopeKey="/workspace"
          hasFolders
          onSessionDroppedOnFolder={(sessionId, folderId) => drops.push({ sessionId, folderId })}
        >
          {null}
        </SessionFolderDndScope>,
      ));
      expect(handleDragEnd).not.toBeNull();

      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-a' } } },
        over: { data: { current: { type: 'folder', folderId: 'folder-a' } } },
      }));
      expect(drops).toEqual([{ sessionId: 'session-a', folderId: 'folder-a' }]);
    } finally {
      await act(async () => root.unmount());
      handleDragEnd = null;
      dom.restore();
    }
  });
});
