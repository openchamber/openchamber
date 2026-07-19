import { beforeEach, describe, expect, test } from 'bun:test';
import type { Todo } from '@opencode-ai/sdk/v2/client';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { cleanupPersistedSessionState } from './session-deletion-cleanup';

const todo: Todo = { content: 'persisted', status: 'pending', priority: 'medium' };

describe('cleanupPersistedSessionState', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {} });
    useTodosPersistStore.setState({ sessions: {} });
    useSessionFoldersStore.setState({ foldersMap: {}, collapsedFolderIds: new Set() });
  });

  test('clears queue and todos only for the deleted composite session', () => {
    const runtimeKey = getRuntimeKey();
    const deleted = createMessageQueueTarget('session-1', '/repo-a', runtimeKey)!;
    const retained = createMessageQueueTarget('session-1', '/repo-b', runtimeKey)!;
    useMessageQueueStore.getState().addToQueue(deleted, { content: 'delete' });
    useMessageQueueStore.getState().addToQueue(retained, { content: 'retain' });
    useTodosPersistStore.getState().setSessionTodos('/repo-a', 'session-1', [todo]);
    useTodosPersistStore.getState().setSessionTodos('/repo-b', 'session-1', [todo]);
    const folder = useSessionFoldersStore.getState().createFolder('/repo-a', 'Active');
    useSessionFoldersStore.getState().addSessionToFolder('/repo-a', folder.id, 'session-1');
    const archivedFolder = useSessionFoldersStore.getState().createFolder('__archived__:/repo-a', 'Archived');
    useSessionFoldersStore.getState().addSessionToFolder('__archived__:/repo-a', archivedFolder.id, 'session-1');

    cleanupPersistedSessionState({ runtimeKey, directory: '/repo-a', sessionId: 'session-1' });

    expect(useMessageQueueStore.getState().getQueueForTarget(deleted)).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueForTarget(retained)).toHaveLength(1);
    expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toBe(undefined);
    expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo]);
    expect(useSessionFoldersStore.getState().getSessionFolderId('/repo-a', 'session-1')).toBeNull();
    expect(useSessionFoldersStore.getState().getSessionFolderId('__archived__:/repo-a', 'session-1')).toBeNull();
  });

  test('rejects stale runtime cleanup', () => {
    const runtimeKey = getRuntimeKey();
    useTodosPersistStore.getState().setSessionTodos('/repo', 'session-1', [todo]);

    cleanupPersistedSessionState({ runtimeKey: `${runtimeKey}-stale`, directory: '/repo', sessionId: 'session-1' });

    expect(useTodosPersistStore.getState().getSessionTodos('/repo', 'session-1')).toEqual([todo]);
  });
});
