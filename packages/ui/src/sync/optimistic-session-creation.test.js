import { afterEach, beforeEach, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from './session-ui-store';
import { ChildStoreManager } from './child-store';
import { abortCurrentOperation, setActionRefs, setOptimisticRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { mergeBootstrapSessions } from './reconnect-recovery';
import { isPendingSessionCreation } from './pending-session-creation';
import { readLastActiveSession } from './last-session-cache';
import { setSessionProjectContextPin } from '@/lib/sessionKnowledgeApi';
import { setSessionGoal } from '@/lib/sessionGoalActions';
import { createInputHistoryIdentity, createInputHistorySubmission, selectInputHistoryEntries, useInputHistoryStore } from '@/stores/useInputHistoryStore';

const directory = '/optimistic-repo';
const draft = { draftId: 2026, open: true, target: 'project', directoryOverride: directory, parentID: null, preserveDirectoryOverride: true,
  projectContextPins: { notes: ['note-1'], plans: [] } };
let stores, loader, response, inserted, originalConfig, originals, originalFetch;
let sent, requests, knowledgeSyncs, historyReads, aborts;

beforeEach(() => {
  draft.draftId += 1;
  response = Promise.withResolvers();
  inserted = Promise.withResolvers();
  sent = []; requests = []; knowledgeSyncs = []; historyReads = []; aborts = [];
  originals = { createSession: opencodeClient.createSession, sendMessage: opencodeClient.sendMessage,
    listSessionsPage: opencodeClient.listSessionsPage, getFilesystemHomeInfo: opencodeClient.getFilesystemHomeInfo,
    abortSession: opencodeClient.abortSession, getSession: opencodeClient.getSession };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.endsWith('/api/session-knowledge/sync')) {
      knowledgeSyncs.push({ method: init.method, body: JSON.parse(init.body) });
    }
    return Response.json(url.includes('session-knowledge') ? { text: '', signature: '' } : {});
  };
  opencodeClient.createSession = async () => response.promise;
  opencodeClient.getSession = async () => response.promise;
  opencodeClient.sendMessage = async (params) => { sent.push(params); return 'accepted'; };
  opencodeClient.abortSession = async (id) => { aborts.push(id); return true; };
  opencodeClient.listSessionsPage = async () => ({ sessions: [], cursor: {} });
  opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/test', chatsRoot: '/home/test/chats' });
  originalConfig = useConfigStore.getState();
  useConfigStore.setState({ isConnected: true, activateDirectory: async () => {}, agents: [] });
  useProjectsStore.setState({ projects: [directory, '/canonical-repo', '/canonical-history', '/confirmed-recovery'].map((path) => ({ id: path, path })), activeProjectId: directory });
  stores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory);
  setActionRefs(stores, () => directory);
  loader = new SessionMessageLoader(stores, { runtimeKey: getRuntimeKey(), sdk: {
    getSessionMessages: async (id, options, scope) => { historyReads.push({ id, scope }); return { items: [], cursor: {} }; },
  } });
  setImperativeSessionMessageLoader(loader);
  setOptimisticRefs((input) => {
    loader.optimisticAdd(input);
    if (input.message.role === 'user') inserted.resolve(input.message);
  }, (input) => loader.optimisticRemove(input));
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft } });
});

afterEach(() => {
  Object.assign(opencodeClient, originals);
  globalThis.fetch = originalFetch;
  useConfigStore.setState(originalConfig);
  setImperativeSessionMessageLoader(null);
  loader.dispose(); stores.disposeAll();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft, open: false } });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

const send = (options = {}) => useSessionUIStore.getState().sendMessage('first prompt', 'provider', 'model', 'build',
  undefined, undefined, undefined, undefined, 'normal', { draftSnapshot: draft, ...options });
const session = () => ({ id: useSessionUIStore.getState().currentSessionId, directory, projectID: 'project', title: '',
  model: { providerID: 'provider', id: 'model' }, agent: 'build', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } });
const acknowledge = (canonical = directory) => response.resolve({ ...session(), projectID: 'project', directory: canonical });

test('opens the session and prompt when creation has not answered', async () => {
  // Given an unresolved server create.
  const sending = send();
  // When the prompt is materialized locally.
  const prompt = await inserted.promise;
  // Then navigation and message coverage are local, with no session requests yet.
  expect(useSessionUIStore.getState().currentSessionId).toBe(prompt.sessionID);
  expect(stores.getChild(directory).getState().message[prompt.sessionID]).toEqual([prompt]);
  expect(sent).toEqual([]);
  expect(historyReads).toEqual([]);
  expect(requests.filter((url) => /session-knowledge|message-sent/.test(url))).toEqual([]);
  expect(readLastActiveSession(getRuntimeKey())?.sessionId).not.toBe(prompt.sessionID);
  acknowledge(); await sending;
  expect(sent[0].messageId).toBe(prompt.id);
});

test('retains an authoritative create event while its request is still pending and a later list is empty', async () => {
  // Given the server's creation event arriving before its create response.
  const sending = send();
  const prompt = await inserted.promise;
  const confirmed = session();
  stores.getChild(directory).setState({ session: [confirmed] });
  useGlobalSessionsStore.getState().upsertSession(confirmed);
  const current = stores.getChild(directory).getState();
  // When complete empty snapshots arrive after insertion.
  await useGlobalSessionsStore.getState().loadSessions();
  const bootstrap = mergeBootstrapSessions([], [], current.session, { baselineRevision: current.sessionRevision,
    eventRevision: current.sessionEventRevision, deletedRevision: current.sessionDeletedRevision });
  // Then pending lifetime outranks both snapshots.
  expect(useGlobalSessionsStore.getState().entityById.has(prompt.sessionID)).toBe(true);
  expect(bootstrap.sessions.map((item) => item.id)).toEqual([prompt.sessionID]);
  acknowledge(); await sending;
  expect(isPendingSessionCreation(prompt.sessionID)).toBe(false);
  expect(mergeBootstrapSessions([], [], bootstrap.sessions, { baselineRevision: current.sessionRevision + 10 }).sessions).toEqual([]);
});

test('moves the prompt and its shadow when creation canonicalizes the directory', async () => {
  // Given the first visible prompt under a requested spelling.
  const sending = send();
  const prompt = await inserted.promise;
  // When the server returns its canonical owner and an empty tail read follows.
  acknowledge('/canonical-repo'); await sending;
  await loader.ensure({ directory: '/canonical-repo', sessionID: prompt.sessionID }, { force: true });
  // Then submission, selection and optimistic reconciliation use that owner.
  expect(sent[0].directory).toBe('/canonical-repo');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/canonical-repo');
  expect(stores.getChild(directory).getState().message[prompt.sessionID]).toBeUndefined();
  expect(stores.getChild('/canonical-repo').getState().message[prompt.sessionID]).toEqual([prompt]);
  expect(knowledgeSyncs).toEqual([{ method: 'POST', body: { directory: '/canonical-repo', sessionId: prompt.sessionID, responseStyleInstruction: null } }]);
});

test('records first-prompt history and restorable files under the confirmed directory', async () => {
  // Given a submission containing a durable file reference.
  const file = { id: 'canonical-file', filename: 'context.txt', mimeType: 'text/plain', size: 12,
    dataUrl: 'file:///canonical-history/context.txt' };
  const submission = createInputHistorySubmission('first prompt', [file]);
  const sending = send({ historySubmissions: [submission] });
  const prompt = await inserted.promise;
  // When creation confirms a different spelling of the session's directory.
  acknowledge('/canonical-history'); await sending;
  // Then session recall finds the prompt and file only at the confirmed owner.
  const history = { ...useInputHistoryStore.getState(), scope: 'session' };
  const confirmed = selectInputHistoryEntries(history, createInputHistoryIdentity(getRuntimeKey(), '/canonical-history', prompt.sessionID));
  const provisional = selectInputHistoryEntries(history, createInputHistoryIdentity(getRuntimeKey(), directory, prompt.sessionID));
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0].text).toBe('first prompt');
  expect(confirmed[0].restorableAttachments[0].reference).toBe(file.dataUrl);
  expect(provisional).toEqual([]);
});

test('restores the captured draft and removes messages and shadows when creation fails', async () => {
  // Given a visible optimistic session.
  const outcome = send().catch((error) => error);
  const prompt = await inserted.promise;
  // When the server rejects creation.
  response.reject(new Error('server unavailable'));
  const error = await outcome;
  // Then the composer gets its source draft and no phantom can return through a loader read.
  expect(error.message).toBe('Failed to create session');
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft).toMatchObject(draft);
  expect(useGlobalSessionsStore.getState().entityById.has(prompt.sessionID)).toBe(false);
  await loader.ensure({ directory, sessionID: prompt.sessionID }, { force: true });
  expect(stores.getChild(directory).getState().message[prompt.sessionID]).toEqual([]);
  expect(sent).toEqual([]);
});

test('leaves a newer draft selected when the earlier create fails', async () => {
  // Given a pending create, followed by a deliberate navigation.
  const outcome = send().catch((error) => error);
  await inserted.promise;
  const newer = { ...draft, draftId: 2027, title: 'new draft' };
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: newer });
  // When the old create fails.
  response.reject(new Error('server unavailable')); await outcome;
  // Then recovery does not overwrite the newer draft.
  expect(useSessionUIStore.getState().newSessionDraft).toBe(newer);
});

test('recovers a rejected first delivery under its acknowledged canonical session', async () => {
  // Given a pending create whose prompt will be rejected after acknowledgment.
  opencodeClient.sendMessage = async () => { throw new Error('delivery rejected'); };
  const outcome = send().catch((error) => error);
  const prompt = await inserted.promise;
  // When creation succeeds under a canonical directory and delivery fails.
  acknowledge('/confirmed-recovery');
  const error = await outcome;
  // Then the composer recovery identity follows the real session, not its closed draft.
  expect(error.message).toBe('delivery rejected');
  expect(error).toMatchObject({ sessionId: prompt.sessionID, directory: '/confirmed-recovery', sessionCreated: true });
  expect(useSessionUIStore.getState().currentSessionId).toBe(prompt.sessionID);
});

test('cancels the first prompt when Stop arrives before creation acknowledges', async () => {
  // Given an unacknowledged create with its prompt already visible.
  const style = Promise.withResolvers();
  const outcome = send({ responseStyle: style.promise }).catch((error) => error);
  const prompt = await inserted.promise;
  const confirmed = { ...session(), projectID: 'project' };
  // When Stop is pressed twice before the server create returns.
  await Promise.all([abortCurrentOperation(prompt.sessionID), abortCurrentOperation(prompt.sessionID)]);
  const error = await outcome;
  const recoveredDraft = useSessionUIStore.getState().newSessionDraft;
  response.resolve(confirmed);
  style.resolve('deferred settings');
  await new Promise((resolve) => setImmediate(resolve));
  // Then no prompt or premature interrupt reaches the server, and late acknowledgment cannot restore it.
  expect(error.cause.reason).toBe('cancelled');
  expect(sent).toEqual([]);
  expect(aborts).toEqual([]);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft).toBe(recoveredDraft);
  expect(recoveredDraft).toMatchObject(draft);
  expect(stores.getChild(directory).getState().message[prompt.sessionID]).toBeUndefined();
  expect(useGlobalSessionsStore.getState().entityById.has(prompt.sessionID)).toBe(false);
});

test('does not write a goal or knowledge pin when pending creation fails', async () => {
  // Given an unacknowledged session already visible in the UI.
  const outcome = send().catch((error) => error);
  const prompt = await inserted.promise;
  const goal = setSessionGoal(prompt.sessionID, directory, { objective: 'objective', tokenBudget: null }, null);
  const pin = setSessionProjectContextPin(directory, prompt.sessionID, 'note', 'another-note', true);
  // When creation fails while those actions wait.
  response.reject(new Error('server unavailable'));
  const [goalResult, pinResult] = await Promise.allSettled([goal, pin]);
  await outcome;
  // Then no session-owned write reaches the server.
  expect(goalResult.status).toBe('rejected');
  expect(pinResult).toEqual({ status: 'fulfilled', value: null });
  expect(requests.filter((url) => /goal|session-knowledge/.test(url))).toEqual([]);
});

test('submits follow-ups after the first prompt when creation is still pending', async () => {
  // Given a first prompt whose eventual server submission is also held.
  const firstRequest = Promise.withResolvers();
  const accepted = Promise.withResolvers();
  opencodeClient.sendMessage = async (params) => {
    sent.push(params);
    if (params.text === 'first prompt') { firstRequest.resolve(); await accepted.promise; }
  };
  const first = send();
  const prompt = await inserted.promise;
  inserted = Promise.withResolvers();
  // When another send reaches the same pending session.
  const followUp = useSessionUIStore.getState().sendMessage('follow-up', 'provider', 'model', 'build',
    undefined, undefined, undefined, undefined, 'normal', { sessionId: prompt.sessionID, directory });
  await inserted.promise;
  acknowledge(); await firstRequest.promise;
  // Then the follow-up stays local until the first submission resolves.
  expect(sent.map((item) => item.text)).toEqual(['first prompt']);
  accepted.resolve(); await Promise.all([first, followUp]);
  expect(sent.map((item) => item.text)).toEqual(['first prompt', 'follow-up']);
});

test('rejects a stale SDK completion without changing the destination cache', async () => {
  // Given a pending create whose originating SDK is replaced.
  const outcome = send().catch((error) => error);
  const prompt = await inserted.promise;
  const confirmed = { ...session(), directory: '/destination' };
  opencodeClient.reconnectToRuntimeBaseUrl();
  useGlobalSessionsStore.getState().applySnapshot([confirmed], []);
  const destination = useGlobalSessionsStore.getState().activeSessions;
  useSessionUIStore.setState({ currentSessionId: 'destination-session', currentSessionDirectory: '/destination' });
  // When the old response finally arrives.
  response.resolve(confirmed); const error = await outcome;
  // Then no prompt or stale reconciliation reaches the new SDK.
  expect(error.cause.reason).toBe('runtime-changed');
  expect(sent).toEqual([]);
  expect(useGlobalSessionsStore.getState().activeSessions).toBe(destination);
  expect(useSessionUIStore.getState().currentSessionId).toBe('destination-session');
  expect(useSessionUIStore.getState().pendingDraftSends.has(prompt.sessionID)).toBe(false);
  expect(isPendingSessionCreation(prompt.sessionID)).toBe(false);
});
