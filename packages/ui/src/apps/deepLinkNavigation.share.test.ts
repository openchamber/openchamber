import { beforeEach, expect, test } from 'bun:test';

import { resolveOpenWorkDraftIdentity, resolveWorkDraftComposerKey } from '@/components/chat/composer/input/composerDraftIdentity';
import { readChatDraft, readChatDraftClaimingFolderDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { openSharedFilesSession } from './deepLinkNavigation';

const file = new File(['shared'], 'notes.txt', { type: 'text/plain' });

beforeEach(() => {
  useInputStore.setState({ pendingDraftContent: null });
  useProjectsStore.setState({ projects: [], activeProjectId: null, hasServerSnapshot: true, serverSnapshotFailed: false });
});

const openWorkDraftIdentity = () => {
  const { workDraftId } = useSessionUIStore.getState().newSessionDraft;
  const identity = workDraftId ? resolveOpenWorkDraftIdentity(workDraftId, getRuntimeKey()) : null;
  if (!identity) throw new Error('no open work draft');
  return identity;
};

test('a share opens its draft in the last-used project, next to the draft already there', () => {
  useProjectsStore.setState({
    projects: [{ id: 'first', path: '/repo-first' }, { id: 'last', path: '/repo-last' }],
    activeProjectId: 'last',
  });
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'last' });
  const existing = openWorkDraftIdentity();
  writeChatDraft(existing, 'draft already in the project', []);
  const folder = { ...existing, sessionId: null };
  writeChatDraft(folder, 'folder draft', []);
  // The user moved on to a Chat draft, so the last draft target is Chat.
  useSessionUIStore.getState().openNewSessionDraft({ target: 'chat' });

  openSharedFilesSession({ type: 'shared-files', files: [], text: 'https://example.com/x', rejected: [] });

  const draft = useSessionUIStore.getState().newSessionDraft;
  expect(draft.target).toBe('project');
  expect(draft.selectedProjectId).toBe('last');
  expect(draft.directoryOverride).toBe('/repo-last');
  const share = openWorkDraftIdentity();
  expect(share.sessionId).not.toBe(existing.sessionId);
  expect(readChatDraftClaimingFolderDraft(share).text).toBe('');
  expect(readChatDraft(existing).text).toBe('draft already in the project');
  expect(readChatDraft(folder).text).toBe('folder draft');
  expect(useInputStore.getState().pendingDraftContent?.draftId).toBe(draft.draftId);
});

test('with no project at all, a share opens its own Chat draft next to the one the user was writing', () => {
  useSessionUIStore.getState().openNewSessionDraft({ target: 'chat' });
  const before = useSessionUIStore.getState().newSessionDraft;

  openSharedFilesSession({ type: 'shared-files', files: [file], text: 'Look at this', rejected: [] });

  const draft = useSessionUIStore.getState().newSessionDraft;
  expect(draft.target).toBe('chat');
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

test("a share waits for the server's project list instead of taking an empty cache for no project", () => {
  useProjectsStore.setState({ hasServerSnapshot: false });
  useSessionUIStore.getState().openNewSessionDraft({ target: 'chat' });
  const before = useSessionUIStore.getState().newSessionDraft;
  const share = { type: 'shared-files' as const, files: [], text: 'https://example.com/x', rejected: [] };

  expect(openSharedFilesSession(share)).toBe(false);
  expect(useSessionUIStore.getState().newSessionDraft.draftId).toBe(before.draftId);
  expect(useInputStore.getState().pendingDraftContent).toBeNull();

  useProjectsStore.setState({ projects: [{ id: 'only', path: '/repo-only' }], activeProjectId: 'only', hasServerSnapshot: true });
  expect(openSharedFilesSession(share)).toBe(true);
  expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('only');
});
