import { beforeEach, describe, expect, test } from 'bun:test';
import type { Todo } from '@opencode-ai/sdk/v2/client';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { cleanupPersistedSessionState } from './session-deletion-cleanup';

const todo: Todo = { content: 'persisted', status: 'pending', priority: 'medium' };

describe('cleanupPersistedSessionState', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {} });
    useTodosPersistStore.setState({ sessions: {} });
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
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
    const deletedDraft = createChatDraftIdentity(runtimeKey, '/repo-a', 'session-1')!;
    const retainedDraft = createChatDraftIdentity(runtimeKey, '/repo-b', 'session-1')!;
    writeChatDraft(deletedDraft, 'delete', []);
    writeChatDraft(retainedDraft, 'retain', []);
    const inlineDraft = {
      source: 'terminal' as const,
      fileLabel: 'Terminal',
      startLine: 1,
      endLine: 1,
      code: 'context',
      language: 'text',
      text: '',
    };
    useInlineCommentDraftStore.getState().addDraft({ directory: '/repo-a', sessionKey: 'session-1' }, inlineDraft);
    useInlineCommentDraftStore.getState().addDraft({ directory: '/repo-b', sessionKey: 'session-1' }, inlineDraft);
    useSessionPinnedStore.getState().toggle({ directory: '/repo-a', sessionId: 'session-1' });
    useSessionPinnedStore.getState().toggle({ directory: '/repo-b', sessionId: 'session-1' });
    const folder = useSessionFoldersStore.getState().createFolder('/repo-a', 'Active');
    useSessionFoldersStore.getState().addSessionToFolder('/repo-a', folder.id, 'session-1');
    const archivedFolder = useSessionFoldersStore.getState().createFolder('__archived__:/repo-a', 'Archived');
    useSessionFoldersStore.getState().addSessionToFolder('__archived__:/repo-a', archivedFolder.id, 'session-1');

    cleanupPersistedSessionState({ runtimeKey, directory: '/repo-a', sessionId: 'session-1' });

    expect(useMessageQueueStore.getState().getQueueForTarget(deleted)).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueForTarget(retained)).toHaveLength(1);
    expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toBe(undefined);
    expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo]);
    expect(readChatDraft(deletedDraft).text).toBe('');
    expect(readChatDraft(retainedDraft).text).toBe('retain');
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: '/repo-a', sessionKey: 'session-1' })).toEqual([]);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: '/repo-b', sessionKey: 'session-1' })).toHaveLength(1);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-a', 'session-1')).toBe(false);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-b', 'session-1')).toBe(true);
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
