import { afterEach, beforeEach, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { routeMessage, useSessionUIStore } from './session-ui-store';
import { ChildStoreManager } from './child-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { deferSessionOperation, waitForFirstSessionSubmission } from './pending-session-creation';

const directory = '/first-dispatch';
const draft = { draftId: 711, open: true, target: 'project', directoryOverride: directory, parentID: null, preserveDirectoryOverride: true };
let stores, loader, response, inserted, originals, originalConfig, originalCommands, originalFetch, messages, commands;

beforeEach(() => {
  draft.draftId += 1;
  response = deferSessionOperation(); inserted = deferSessionOperation();
  messages = []; commands = [];
  originals = { createSession: opencodeClient.createSession, sendMessage: opencodeClient.sendMessage,
    sendCommand: opencodeClient.sendCommand, getFilesystemHomeInfo: opencodeClient.getFilesystemHomeInfo,
    getSessionMessages: opencodeClient.getSessionMessages, shellSession: opencodeClient.shellSession,
    getSession: opencodeClient.getSession };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ text: '', signature: '' });
  opencodeClient.createSession = async () => response.promise;
  opencodeClient.getSession = async (id, scope) => stores.getChild(scope)?.getState().session.find((entry) => entry.id === id) ?? response.promise;
  opencodeClient.sendMessage = async (params) => { messages.push(params); return 'accepted'; };
  opencodeClient.sendCommand = async (params) => { commands.push(params); return 'accepted'; };
  opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/test', chatsRoot: '/home/test/chats' });
  originalConfig = useConfigStore.getState(); originalCommands = useCommandsStore.getState();
  useConfigStore.setState({ isConnected: true, hasEverConnected: true, activateDirectory: async () => {}, agents: [] });
  useSessionGoalArmStore.getState().setArmed(false, null);
  useProjectsStore.setState({ projects: [
    { id: 'project', path: directory },
    { id: 'canonical-first-dispatch', path: '/canonical-first-dispatch' },
    { id: 'canonical-knowledge', path: '/canonical-knowledge' },
    { id: 'canonical-accepted-dispatch', path: '/canonical-accepted-dispatch' },
  ], activeProjectId: null });
  stores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory); setActionRefs(stores, () => directory);
  loader = new SessionMessageLoader(stores, { runtimeKey: getRuntimeKey(), sdk: { getSessionMessages: async () => ({ items: [], cursor: {} }) } });
  setImperativeSessionMessageLoader(loader);
  setOptimisticRefs((input) => {
    loader.optimisticAdd(input);
    if (input.message.role === 'user') inserted.resolve(input.message);
  }, (input) => loader.optimisticRemove(input));
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft } });
});

afterEach(() => {
  Object.assign(opencodeClient, originals); globalThis.fetch = originalFetch;
  useConfigStore.setState(originalConfig); useCommandsStore.setState(originalCommands);
  setImperativeSessionMessageLoader(null); loader.dispose(); stores.disposeAll();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft, open: false } });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

const send = (providerID = 'provider', modelID = 'model') => useSessionUIStore.getState().sendMessage(
  'first', providerID, modelID, 'build', undefined, undefined, undefined, undefined, 'normal', { draftSnapshot: draft });
const current = (id) => ({ id, directory, projectID: 'project', title: '', agent: 'build',
  model: { providerID: 'provider', id: 'model' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } });
const followUp = (sessionId) => useSessionUIStore.getState().sendMessage('next', 'provider', 'model', 'build',
  undefined, undefined, undefined, undefined, 'normal', { sessionId, directory });

test('compares Auto against the acknowledged model when the first prompt dispatches', async () => {
  // Given a draft that provisionally claims Auto while creation is pending.
  const sending = send(AUTO_PROVIDER_ID, AUTO_MODEL_ID);
  const prompt = await inserted.promise;
  // When the server creates it on a concrete model, as the Auto-omitting create adapter does.
  useConfigStore.setState({ currentProviderId: 'unrelated', currentModelId: 'new-pick' });
  response.resolve({ ...current(prompt.sessionID), model: { providerID: 'server', id: 'fallback' } });
  await sending;
  // Then the first prompt requests the captured Auto switch.
  expect(messages[0].model).toEqual({ providerID: AUTO_PROVIDER_ID, id: AUTO_MODEL_ID });
});

test('compares command selection after its readiness resolves', async () => {
  // Given a provisional record claiming the desired selection.
  const session = { id: 'ses_command', directory, projectID: 'project', title: '', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
    model: { providerID: 'desired', id: 'chosen', variant: 'high' } };
  const store = stores.ensureChild(directory, { bootstrap: false });
  store.setState({ session: [session] });
  useCommandsStore.setState({ commandsByDirectory: { [directory]: [{ name: 'known' }] } });
  const ready = deferSessionOperation();
  // When readiness replaces the record with the server's concrete selection.
  const sending = routeMessage({ sessionId: session.id, directory, content: '/known', providerID: 'desired',
    modelID: 'chosen', variant: 'high', ready: ready.promise });
  store.setState({ session: [{ ...session, model: { providerID: 'server', id: 'fallback' } }] });
  ready.resolve({ sessionId: session.id, directory });
  await sending;
  // Then the command preserves the captured desired choice and sends its required switch.
  expect(commands[0].model).toEqual({ providerID: 'desired', id: 'chosen', variant: 'high' });
});

test('dispatches to the authoritative owner when a parent store contains a worktree session', async () => {
  // Given a parent list holding a session whose record names a different owner.
  const owner = '/first-dispatch/worktree';
  const session = { ...current('ses_worktree_owner'), directory: owner };
  stores.ensureChild(directory, { bootstrap: false }).setState({ session: [session] });
  stores.ensureChild(owner, { bootstrap: false }).setState({ session: [session] });
  useGlobalSessionsStore.getState().upsertSession(session);
  useCommandsStore.setState({ commandsByDirectory: { [directory]: [{ name: 'known' }] } });
  // When a command carries a stale directory hint from the parent.
  await routeMessage({ sessionId: session.id, directory, content: '/known', providerID: 'provider', modelID: 'model', agent: 'build' });
  // Then its dispatch resolves the record's owner and its unchanged selection.
  expect(commands[0]).toMatchObject({ directory: owner, model: undefined, agent: undefined });
});

test('rolls back a waiting follow-up when the acknowledged initial submission fails', async () => {
  // Given two optimistic prompts and an acknowledged canonical directory.
  const delivery = deferSessionOperation(); const started = deferSessionOperation();
  opencodeClient.sendMessage = async (params) => { messages.push(params); started.resolve(); return delivery.promise; };
  const first = send(); const prompt = await inserted.promise;
  inserted = deferSessionOperation();
  const next = followUp(prompt.sessionID); await inserted.promise;
  const canonical = '/canonical-first-dispatch';
  response.resolve({ ...current(prompt.sessionID), directory: canonical }); await started.promise;
  // When the first server submission is rejected.
  delivery.reject(Object.assign(new Error('rejected'), { status: 400 }));
  const results = await Promise.allSettled([first, next]);
  // Then both local bubbles and their loader shadows disappear while the confirmed session remains.
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(messages).toHaveLength(1);
  await loader.ensure({ directory: canonical, sessionID: prompt.sessionID }, { force: true });
  expect(stores.getChild(canonical).getState().message[prompt.sessionID]).toEqual([]);
  expect(useGlobalSessionsStore.getState().entityById.has(prompt.sessionID)).toBe(true);
});

test('serializes knowledge writes behind the initial submission and before each prompt', async () => {
  // Given held server-side knowledge writes and two optimistic prompts.
  const initialSync = deferSessionOperation(); const initialSyncStarted = deferSessionOperation();
  const nextSync = deferSessionOperation(); const nextSyncStarted = deferSessionOperation();
  const delivery = deferSessionOperation(); const started = deferSessionOperation();
  const knowledgeWrites = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/session-knowledge/sync')) {
      knowledgeWrites.push({ method: init.method, body: JSON.parse(init.body) });
      if (knowledgeWrites.length === 1) {
        initialSyncStarted.resolve(); await initialSync.promise;
      } else {
        nextSyncStarted.resolve(); await nextSync.promise;
      }
    }
    return Response.json({});
  };
  opencodeClient.sendMessage = async (params) => {
    messages.push(params);
    if (messages.length === 1) { started.resolve(); await delivery.promise; }
    return 'accepted';
  };
  const first = send(); const prompt = await inserted.promise;
  inserted = deferSessionOperation(); const next = followUp(prompt.sessionID); await inserted.promise;
  const canonical = '/canonical-knowledge';
  response.resolve({ ...current(prompt.sessionID), directory: canonical });
  try {
    await initialSyncStarted.promise;
    expect(waitForFirstSessionSubmission(prompt.sessionID)).toBeDefined();
    expect(messages).toHaveLength(0);
    initialSync.resolve(); await started.promise;
    expect(knowledgeWrites).toHaveLength(1);
    // When the initial prompt is accepted and the follower's knowledge write starts.
    delivery.resolve(); await first; await nextSyncStarted.promise;
    // Then that write targets the confirmed owner and gates the second prompt.
    expect(knowledgeWrites).toEqual([
      { method: 'POST', body: { directory: canonical, sessionId: prompt.sessionID, responseStyleInstruction: null } },
      { method: 'POST', body: { directory: canonical, sessionId: prompt.sessionID, responseStyleInstruction: null } },
    ]);
    expect(messages).toHaveLength(1);
  } finally {
    initialSync.resolve(); delivery.resolve(); nextSync.resolve();
    await Promise.all([first, next]);
  }
  expect(messages).toHaveLength(2);
  expect(messages[0].context ?? []).toEqual([]);
  expect(messages[1].context ?? []).toEqual([]);
});

test('materializes confirmation of a lost first-prompt acknowledgement in the canonical directory', async () => {
  // Given a prompt accepted after creation canonicalizes its requested directory.
  const canonical = '/canonical-accepted-dispatch';
  const confirmations = [];
  const sending = send();
  const prompt = await inserted.promise;
  const assistant = { id: 'msg_confirmed_assistant', role: 'assistant', sessionID: prompt.sessionID,
    time: { created: prompt.time.created + 1, completed: prompt.time.created + 2 } };
  opencodeClient.getSessionMessages = async (_id, _options, scope) => {
    confirmations.push(scope);
    return { items: [{ info: prompt, parts: [] }, { info: assistant, parts: [] }], cursor: {} };
  };
  opencodeClient.sendMessage = async () => { throw new TypeError('Failed to fetch'); };
  // When the prompt response is lost and confirmation recovers the accepted records.
  response.resolve({ ...current(prompt.sessionID), directory: canonical });
  await sending;
  // Then both the read and materialized assistant belong to the confirmed owner.
  expect(confirmations).toEqual([canonical]);
  expect(stores.getChild(canonical).getState().message[prompt.sessionID].map((message) => message.id))
    .toEqual([prompt.id, assistant.id]);
  expect(stores.getChild(directory).getState().message[prompt.sessionID]).toBeUndefined();
});

test('admits follow-ups once the first shell starts while that command is still running', async () => {
  // Given a first shell whose process remains running after creation acknowledges.
  const creating = deferSessionOperation();
  const started = deferSessionOperation();
  const exited = deferSessionOperation();
  opencodeClient.createSession = async (params) => { creating.resolve(params.id); return response.promise; };
  opencodeClient.shellSession = async () => { started.resolve(); return exited.promise; };
  const shell = useSessionUIStore.getState().sendMessage('long-command', 'provider', 'model', 'build',
    undefined, undefined, undefined, undefined, 'shell', { draftSnapshot: draft });
  const sessionId = await creating.promise;
  response.resolve(current(sessionId));
  await started.promise;
  try {
    // When a later message targets the running shell's session.
    expect(waitForFirstSessionSubmission(sessionId)).toBeUndefined();
    await followUp(sessionId);
    // Then delivery does not wait for the shell's exit.
    expect(messages.map((message) => message.text)).toEqual(['next']);
  } finally {
    exited.resolve('finished');
    await shell;
  }
});
