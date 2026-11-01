import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { INITIAL_STATE } from '@/sync/types';
import { createRuntimeOpencodeClient, opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import * as syncRefs from '@/sync/sync-refs';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import * as sessionActions from '@/sync/session-actions';
import { promptGuestSession, startGuestSession } from './start-session';
import * as worktreeCreate from '@/lib/worktrees/worktreeCreate';
import * as worktreeBootstrap from '@/lib/worktrees/worktreeBootstrap';
import * as projectConfig from '@/lib/openchamberConfig';
import * as sharedTrust from '@/lib/sharedTrustConfirmation';

const created: Session = {
  id: 'background-session', directory: '/project-b', title: 'Task', projectID: 'b', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
const originalSendMessage = useSessionUIStore.getState().sendMessage;
const originalLastUserChoice = useSessionUIStore.getState().getLastUserChoice;
afterEach(() => {
  mock.restore();
  useSessionUIStore.setState({ sendMessage: originalSendMessage, getLastUserChoice: originalLastUserChoice });
});

test('a guest prompt sends the target session selection rather than the app default', async () => {
  const sessionId = 'guest-prompt-target';
  const selection = useSelectionStore.getState();
  selection.saveSessionAgentSelection(sessionId, 'plan');
  selection.saveSessionModelSelection(sessionId, 'chosen', 'model');
  selection.saveAgentModelForSession(sessionId, 'plan', 'chosen', 'model');
  selection.saveAgentModelVariantForSession(sessionId, 'plan', 'chosen', 'model', 'high');
  const config = useConfigStore.getState();
  useConfigStore.setState({ currentProviderId: 'default', currentModelId: 'other', currentAgentName: 'build' });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    const result = await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(result).toEqual({ ok: true, result: { sent: 'sent' } });
    expect(send.mock.calls[0]).toEqual(['Synthetic prompt', 'chosen', 'model', 'plan', undefined,
      undefined, undefined, 'high', undefined, { sessionId, directory: '/synthetic' }]);
  } finally {
    selection.clearSessionSelections(sessionId);
    useConfigStore.setState({ currentProviderId: config.currentProviderId, currentModelId: config.currentModelId, currentAgentName: config.currentAgentName });
  }
});

test('a guest prompt preserves an explicit default effort over older session history', async () => {
  const sessionId = 'guest-prompt-default-effort';
  const selection = useSelectionStore.getState();
  selection.saveSessionAgentSelection(sessionId, 'plan');
  selection.saveSessionModelSelection(sessionId, 'chosen', 'model');
  selection.saveAgentModelVariantForSession(sessionId, 'plan', 'chosen', 'model', null);
  const state = useSessionUIStore.getState();
  spyOn(state, 'getLastUserChoice').mockReturnValue({ agent: 'plan', providerID: 'chosen', modelID: 'model', variant: 'high' });
  const send = spyOn(state, 'sendMessage').mockResolvedValue(undefined);
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['chosen', 'model', 'plan']);
    expect(send.mock.calls[0]?.[7]).toBeNull();
  } finally {
    selection.clearSessionSelections(sessionId);
  }
});

test('a guest prompt uses the target session history when there is no local pick', async () => {
  const state = useSessionUIStore.getState();
  spyOn(state, 'getLastUserChoice').mockReturnValue({ agent: 'plan', providerID: 'history', modelID: 'model', variant: 'high' });
  const send = spyOn(state, 'sendMessage').mockResolvedValue(undefined);
  await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId: 'guest-history-only',
    directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
  expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['history', 'model', 'plan']);
  expect(send.mock.calls[0]?.[7]).toBe('high');
});

test('a guest prompt to the active session uses the visible composer selection', async () => {
  const state = useSessionUIStore.getState();
  const config = useConfigStore.getState();
  const send = spyOn(state, 'sendMessage').mockResolvedValue(undefined);
  useSessionUIStore.setState({ currentSessionId: 'visible-session' });
  useConfigStore.setState({ currentProviderId: 'visible', currentModelId: 'model', currentAgentName: 'plan', currentVariant: 'high' });
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId: 'visible-session',
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['visible', 'model', 'plan']);
    expect(send.mock.calls[0]?.[7]).toBe('high');
  } finally {
    useSessionUIStore.setState({ currentSessionId: state.currentSessionId });
    useConfigStore.setState({ currentProviderId: config.currentProviderId, currentModelId: config.currentModelId,
      currentAgentName: config.currentAgentName, currentVariant: config.currentVariant });
  }
});

test('a guest prompt carries an unsent agent pick for the active session', async () => {
  const state = useSessionUIStore.getState();
  const config = useConfigStore.getState();
  const selection = useSelectionStore.getState();
  selection.pickSessionAgent('active-picked-agent', 'plan');
  const send = spyOn(state, 'sendMessage').mockResolvedValue(undefined);
  useSessionUIStore.setState({ currentSessionId: 'active-picked-agent' });
  useConfigStore.setState({ currentProviderId: 'visible', currentModelId: 'model', currentAgentName: 'build' });
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId: 'active-picked-agent',
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.[3]).toBe('plan');
  } finally {
    selection.clearSessionSelections('active-picked-agent');
    useSessionUIStore.setState({ currentSessionId: state.currentSessionId });
    useConfigStore.setState({ currentProviderId: config.currentProviderId, currentModelId: config.currentModelId, currentAgentName: config.currentAgentName });
  }
});

test('a guest prompt follows the session record even when the panel directory does not match the store key', async () => {
  const sessionId = 'guest-path-form-mismatch';
  const selection = useSelectionStore.getState();
  selection.saveSessionAgentSelection(sessionId, 'old-agent');
  selection.followSessionAgent(sessionId, 'old-agent');
  selection.saveSessionModelSelection(sessionId, 'old', 'model');
  selection.markSessionModelFollowed(sessionId, 'old/model#');
  // The directory child store is keyed by the normalized path, but the panel
  // can hold a different form (case, separators, trailing slash), so no store
  // answers for that string at all. The send path then falls back to the
  // cross-directory map; the capture must see the same record.
  spyOn(syncRefs, 'getDirectoryState').mockReturnValue(undefined);
  spyOn(syncRefs, 'getAllSyncSessions').mockReturnValue([{ ...created, id: sessionId, agent: 'new-agent', model: { providerID: 'new', id: 'model', variant: 'high' } }]);
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: 'C:/Users/test/project/', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['new', 'model', 'new-agent']);
    expect(send.mock.calls[0]?.[7]).toBe('high');
  } finally {
    selection.clearSessionSelections(sessionId);
  }
});

test('a guest prompt follows a newer model and agent on a background session record', async () => {
  const sessionId = 'guest-switched-session';
  const selection = useSelectionStore.getState();
  selection.saveSessionAgentSelection(sessionId, 'old-agent');
  selection.followSessionAgent(sessionId, 'old-agent');
  selection.saveSessionModelSelection(sessionId, 'old', 'model');
  selection.markSessionModelFollowed(sessionId, 'old/model#');
  spyOn(syncRefs, 'getDirectoryState').mockReturnValue({ ...INITIAL_STATE, session: [{ ...created, id: sessionId, agent: 'new-agent', model: { providerID: 'new', id: 'model', variant: 'high' } }] });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['new', 'model', 'new-agent']);
    expect(send.mock.calls[0]?.[7]).toBe('high');
  } finally {
    selection.clearSessionSelections(sessionId);
  }
});

test('a guest prompt uses the first background session record effort', async () => {
  const sessionId = 'guest-first-record';
  spyOn(syncRefs, 'getDirectoryState').mockReturnValue({ ...INITIAL_STATE, session: [{ ...created, id: sessionId, agent: 'plan', model: { providerID: 'new', id: 'model', variant: 'high' } }] });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
    directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
  expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['new', 'model', 'plan']);
  expect(send.mock.calls[0]?.[7]).toBe('high');
});

test('a switched background record without effort keeps the saved effort for that model', async () => {
  const sessionId = 'guest-switched-no-effort';
  const selection = useSelectionStore.getState();
  selection.markSessionModelFollowed(sessionId, 'old/model#');
  selection.saveAgentModelVariantForSession(sessionId, 'plan', 'new', 'model', 'high');
  spyOn(syncRefs, 'getDirectoryState').mockReturnValue({ ...INITIAL_STATE, session: [{ ...created, id: sessionId, agent: 'plan', model: { providerID: 'new', id: 'model' } }] });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.[7]).toBe('high');
  } finally {
    selection.clearSessionSelections(sessionId);
  }
});

test('a background agent switch retains the session model, not an older model for that agent', async () => {
  const sessionId = 'guest-agent-switched';
  const selection = useSelectionStore.getState();
  selection.followSessionAgent(sessionId, 'build');
  selection.saveSessionModelSelection(sessionId, 'current', 'model');
  selection.saveAgentModelForSession(sessionId, 'plan', 'older', 'model');
  spyOn(syncRefs, 'getDirectoryState').mockReturnValue({ ...INITIAL_STATE, session: [{ ...created, id: sessionId, agent: 'plan', model: { providerID: 'current', id: 'model' } }] });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await promptGuestSession({ request: { text: 'Synthetic prompt', send: true }, sessionId,
      directory: '/synthetic', busy: false, compose: () => {}, t: (key) => key });
    expect(send.mock.calls[0]?.slice(1, 4)).toEqual(['current', 'model', 'plan']);
  } finally {
    selection.clearSessionSelections(sessionId);
  }
});
const setup = () => {
  const create = spyOn(opencodeClient, 'createSession').mockImplementation(async (_input, directory) => ({ ...created, directory: directory ?? created.directory }));
  spyOn(sessionActions, 'setLinkedIssue').mockResolvedValue(created);
  useProjectsStore.setState({ hasServerSnapshot: true, projects: [{ id: 'a', path: '/project-a', addedAt: 1 }, { id: 'b', path: '/project-b', addedAt: 1 }], activeProjectId: 'a' });
  useSessionUIStore.setState({ currentSessionId: 'existing-chat', currentSessionDirectory: '/project-a' });
  useUIStore.getState().setOpenGuestPage('board');
  return create;
};

test('a guest session in another project registers without changing the open page or chat', async () => {
  const create = setup();
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-1', title: 'Task', url: 'https://example.com/task', projectId: 'b' } });
  expect(create.mock.calls[0]?.[1]).toBe('/project-b');
  expect(result).toMatchObject({ sessionId: created.id, directory: '/project-b', sent: 'skipped', linked: true });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/project-a');
  expect(useProjectsStore.getState().activeProjectId).toBe('a');
  expect(useUIStore.getState().openGuestPageId).toBe('board');
  expect(useGlobalSessionsStore.getState().entityById.get(created.id)?.directory).toBe('/project-b');
});

test('named worktrees forward the base ref through existing creation and keep bootstrap failures explicit', async () => {
  const create = setup();
  const createTree = spyOn(worktreeCreate, 'createWorktreeWithDefaults').mockResolvedValue({
    path: '/isolated-fix', projectDirectory: '/project-b', branch: 'fix-login', label: 'fix-login', name: 'fix-login', worktreeStatus: 'pending',
  });
  spyOn(sharedTrust, 'resolveWorktreeSetupCommands').mockResolvedValue([]);
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(true);
  spyOn(worktreeBootstrap, 'waitForWorktreeBootstrap').mockRejectedValue(new Error('Setup failed'));
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-2', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'new', name: 'fix-login', baseBranch: 'release' } } });
  expect(createTree.mock.calls[0]?.[0]).toMatchObject({ id: 'b', path: '/project-b' });
  expect(createTree.mock.calls[0]?.[1]).toMatchObject({ branchName: 'fix-login', worktreeName: 'fix-login', startRef: 'release' });
  expect(create.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: null, failure: 'bootstrap-failed', directory: '/isolated-fix', worktree: { branch: 'fix-login' } });
  expect(useUIStore.getState().openGuestPageId).toBe('board');
});

test('existing worktrees create sessions in their directory without creating or scanning worktrees', async () => {
  const create = setup();
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/project-b', [{
    path: '/existing', projectDirectory: '/project-b', branch: 'existing', label: 'existing', worktreeStatus: 'ready',
  }]]]) });
  const tree = spyOn(worktreeCreate, 'createWorktreeWithDefaults');
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(false);
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-3', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'existing', directory: '/existing' } } });
  expect(create.mock.calls[0]?.[1]).toBe('/existing');
  expect(tree.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: created.id, directory: '/existing', worktree: { branch: 'existing' } });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});

test('a replaced SDK client cannot publish a late creation even when the runtime key is unchanged', async () => {
  const create = setup();
  let client = createRuntimeOpencodeClient({ baseUrl: 'http://localhost:1' });
  spyOn(opencodeClient, 'getSdkClient').mockImplementation(() => client);
  create.mockImplementation(async () => {
    client = createRuntimeOpencodeClient({ baseUrl: 'http://localhost:2' });
    return { ...created, id: 'late-session' };
  });
  const result = await sessionActions.createSession('Late', '/project-b', undefined, undefined, undefined, 'preserve');
  expect(result).toBeNull();
  expect(useGlobalSessionsStore.getState().entityById.has('late-session')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});
