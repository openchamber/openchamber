import { beforeEach, expect, test } from 'bun:test';

import { resolveWorkDraftComposerKey } from '@/components/chat/composer/input/composerDraftIdentity';
import { readChatDraft, readChatDraftClaimingFolderDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { openSharedFilesSession } from './deepLinkNavigation';

const file = new File(['shared'], 'notes.txt', { type: 'text/plain' });

beforeEach(() => {
  useInputStore.setState({ pendingDraftContent: null });
});

test('a share opens a draft of its own next to the one the user was writing', () => {
  useSessionUIStore.getState().openNewSessionDraft({ target: 'chat' });
  const before = useSessionUIStore.getState().newSessionDraft;

  openSharedFilesSession({ type: 'shared-files', files: [file], text: 'Look at this', rejected: [] });

  const draft = useSessionUIStore.getState().newSessionDraft;
  expect(draft.draftId).not.toBe(before.draftId);
  expect(draft.workDraftId).not.toBe(before.workDraftId);
  // A chat draft shares one composer slot with every chat draft; the share's keeps its own.
  expect(resolveWorkDraftComposerKey(before)).toBeNull();
  expect(resolveWorkDraftComposerKey(draft)).toBe(`draft:${draft.workDraftId}`);
  expect(useInputStore.getState().pendingDraftContent).toEqual({
    draftId: draft.draftId, files: [file], text: 'Look at this', rejected: [],
  });
});

test("the share's draft never takes over the text of the draft the user was writing", () => {
  const folder = { runtimeKey: 'runtime', directory: '/repo', sessionId: null };
  writeChatDraft(folder, 'half-written prompt', []);

  openSharedFilesSession({ type: 'shared-files', files: [], text: 'https://example.com/x', rejected: [] });

  const { workDraftId } = useSessionUIStore.getState().newSessionDraft;
  const share = { ...folder, sessionId: `draft:${workDraftId}` };
  expect(readChatDraftClaimingFolderDraft(share).text).toBe('');
  expect(readChatDraft(folder).text).toBe('half-written prompt');
});
