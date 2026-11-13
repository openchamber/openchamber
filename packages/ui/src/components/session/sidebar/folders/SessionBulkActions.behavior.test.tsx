import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { installHookTestDom } from '../test-utils/testDom';
import { deriveSessionRowBulkSelectAll } from '../sessions/sessionRowOrder';

type BulkActionCapture = {
  onCreateFolderAndMove: () => void;
  onMoveToFolder: (folderId: string) => void;
  onRemoveFromFolder: () => void;
};

let bulkActionCapture: BulkActionCapture | null = null;

mock.module('./BulkActionBar', () => ({
  BulkActionBar: (props: BulkActionCapture) => {
    bulkActionCapture = props;
    return null;
  },
}));

mock.module('./ConfirmDialogs', () => ({
  BulkSessionDeleteConfirmDialog: () => null,
}));

const { SessionBulkActions } = await import('./SessionBulkActions');

describe('SessionBulkActions public behavior', () => {
  for (const selection of ['single', 'parent', 'select-all'] as const) {
  test(`folder actions stay owner-scoped with ${selection} selection while a row edit is active`, async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    const renameRequests: Array<{ scopeKey: string; folder: { id: string; name: string } }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    const removed: Array<{ scopeKey: string; ids: string[] }> = [];
    useSessionFoldersStore.setState({
      foldersMap: {},
      addSessionsToFolder: (scopeKey, folderId, ids) => moved.push({ scopeKey, folderId, ids }),
      removeSessionsFromFolders: (scopeKey, ids) => removed.push({ scopeKey, ids }),
    });
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['session-a']),
      scopeKey: 'project-a',
      anchorId: 'session-a',
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    if (selection !== 'single') {
      useSessionMultiSelectStore.getState().replaceAll([], 'project-a');
    }
    if (selection === 'parent') {
      useSessionMultiSelectStore.getState().toggleSelected('session-a', 'project-a', ['child-b', 'child-a'], 'parent-row');
    }
    if (selection === 'select-all') {
      const all = deriveSessionRowBulkSelectAll(
        [{ id: 'session-a', rowKey: 'parent-row', scopeKey: 'project-a', archived: false, descendantRange: [0, 2] }],
        ['child-b', 'child-a'],
        'project-a',
      );
      if (!all) throw new Error('Select all must include the parent');
      useSessionMultiSelectStore.getState().replaceAll(all.ids, all.scopeKey);
    }
    const expectedIds = selection === 'single' ? ['session-a'] : ['session-a', 'child-a'];

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForProject={() => [{ scopeKey: '/workspace', directory: '/workspace' }]}
            folderOwnerKeyBySessionId={new Map([['session-a', 'project-a'], ['child-a', 'project-a'], ['child-b', 'project-b']])}
            isInlineEditing
            startFolderRename={(scopeKey, folder) => renameRequests.push({ scopeKey, folder })}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture).not.toBeNull();
      if (selection !== 'single') {
        expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['session-a', 'child-b', 'child-a']);
      }

      await act(async () => bulkActionCapture?.onCreateFolderAndMove());
      const createdFolder = useSessionFoldersStore.getState().foldersMap['/workspace']?.[0];
      expect(createdFolder?.name).toBe('New folder');
      if (!createdFolder) throw new Error('Folder action must create a folder');
      expect(renameRequests).toEqual([{ scopeKey: '/workspace', folder: createdFolder }]);
      expect(moved).toEqual([{ scopeKey: '/workspace', folderId: createdFolder.id, ids: expectedIds }]);
      await act(async () => bulkActionCapture?.onMoveToFolder(createdFolder.id));
      expect(moved).toEqual([
        { scopeKey: '/workspace', folderId: createdFolder.id, ids: expectedIds },
        { scopeKey: '/workspace', folderId: createdFolder.id, ids: expectedIds },
      ]);
      await act(async () => bulkActionCapture?.onRemoveFromFolder());
      expect(removed).toEqual([{ scopeKey: '/workspace', ids: expectedIds }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
      bulkActionCapture = null;
      dom.restore();
    }
  });
  }
});
