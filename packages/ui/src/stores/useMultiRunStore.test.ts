import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Metadata } from '@/lib/opencode/model';
import { directoryEnvironment } from './test-support/directoryEnvironment';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { setSyncRefs } from '@/sync/sync-refs';
import { setActionRefs, setOptimisticRefs } from '@/sync/session-actions';

const environment = directoryEnvironment({ home: '/home/test', lastDirectory: '/repo', fakeTimers: false });
const recordSchema = z.record(z.string(), z.json());
const mergePatch = (current: Metadata, patch: Metadata): Metadata => {
  const base: Metadata = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete base[key]; continue; }
    const nested = recordSchema.safeParse(value);
    if (!nested.success) { base[key] = value; continue; }
    const previous = recordSchema.safeParse(base[key]);
    base[key] = mergePatch(previous.success ? previous.data : {}, nested.data);
  }
  return base;
};
const makeSession = (id: string, title: string, directory: string, metadata: Metadata) => ({
  id, projectID: 'p', title, location: { directory }, metadata,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
const sessions = new Map<string, ReturnType<typeof makeSession>>();
const objectiveFiles = new Map<string, string>();
const registeredDirectories: Array<{ sessionID: string; directory: string }> = [];
const worktreeCreates: Array<{ directory: string | null; body: Metadata }> = [];
const operationOrder: string[] = [];
const dispatchedSessionIds: string[] = [];
const deletedSessionIds: string[] = [];
const dispatchedParts = new Map<string, Array<{ text: string; synthetic: boolean }>>();
const goalWrites: Array<{ sessionId: string; directory: string; objective: string; tokenBudget: number | null }> = [];
const clearedGoals: string[] = [];
let rejectGoalFor: string | null = null;
let rejectPromptFor: string | null = null;
let createdCount = 0;
let rejectNextMembership = false;
let onCreate = () => {};
let isGitRepository = false;
let waitForWorktreeSetup = false;
let bootstrapReady = false;
let releaseBootstrap = () => {};
let bootstrapGate = Promise.resolve();
let markBootstrapStarted = () => {};
let bootstrapStarted = Promise.resolve();
const readyBootstrap = { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 1 };

environment.respond(async (url, init) => {
  const body = init?.body ? recordSchema.parse(JSON.parse(String(init.body))) : {};
  if (url.pathname === '/api/session' && init?.method === 'POST') {
    const input = z.object({
      title: z.string(), metadata: recordSchema, location: z.object({ directory: z.string() }).optional(),
    }).parse(body);
    const createDirectory = input.location?.directory ?? '/opencode-server';
    const id = ++createdCount === 1 ? 'ses_multirun' : `ses_multirun_${createdCount}`;
    const session = makeSession(id, input.title, createDirectory, input.metadata);
    sessions.set(id, session);
    operationOrder.push(`createSession:${createDirectory}`);
    onCreate();
    return Response.json({ data: session });
  }
  const metadataRoute = url.pathname.match(/^\/api\/openchamber\/sessions\/([^/]+)\/metadata$/);
  if (metadataRoute) {
    const sessionId = metadataRoute[1];
    if (rejectNextMembership) {
      rejectNextMembership = false;
      return Response.json({ error: 'membership write failed' }, { status: 503 });
    }
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const patch = recordSchema.parse(body.patch);
    const namespace = recordSchema.safeParse(patch.openchamber);
    const goal = namespace.success ? namespace.data.goal : undefined;
    if (goal === null) clearedGoals.push(sessionId);
    if (goal && typeof goal === 'object') {
      if (rejectGoalFor === sessionId) return Response.json({ error: 'goal write failed' }, { status: 503 });
      const input = z.object({ tokenBudget: z.number().nullable() }).parse(goal);
      goalWrites.push({ sessionId, directory: session.location.directory, objective: objectiveFiles.get(sessionId) ?? '', tokenBudget: input.tokenBudget });
      operationOrder.push(`goal:${sessionId}`);
    }
    session.metadata = mergePatch(session.metadata, patch);
    return Response.json({ metadata: session.metadata });
  }
  const objectiveRoute = url.pathname.match(/^\/api\/goals\/objective\/([^/]+)$/);
  if (objectiveRoute) {
    if (init?.method === 'PUT') objectiveFiles.set(objectiveRoute[1], z.string().parse(body.content));
    else objectiveFiles.delete(objectiveRoute[1]);
    return Response.json({});
  }
  const sessionRoute = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionRoute) {
    const [, sessionId, action] = sessionRoute;
    if (!action && init?.method === 'DELETE') {
      deletedSessionIds.push(sessionId);
      sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }
    if (!action) return Response.json({ data: sessions.get(sessionId) });
    if (action === 'prompt') {
      if (rejectPromptFor === sessionId) return Response.json({ _tag: 'InvalidRequestError', message: 'prompt rejected' }, { status: 400 });
      operationOrder.push(`prompt:${sessionId}`);
      dispatchedSessionIds.push(sessionId);
      return Response.json({ data: {} });
    }
    if (action === 'synthetic') {
      const parts = dispatchedParts.get(sessionId) ?? [];
      parts.push({ text: z.string().parse(body.text), synthetic: true });
      dispatchedParts.set(sessionId, parts);
      return Response.json({ data: {} });
    }
    if (action === 'model') return new Response(null, { status: 204 });
    if (action === 'interrupt') return Response.json({ interrupted: true });
  }
  if (url.pathname === '/api/git/projects' || url.pathname === '/api/git/project-worktrees') {
    const directories = z.array(z.string()).parse(body.directories);
    return Response.json({ projects: directories.map((path) => ({ directory: path, isGitRepository, root: '/repo', worktrees: [] })) });
  }
  if (url.pathname === '/api/git/status') return Response.json({ isClean: true, current: 'main', tracking: null, ahead: 0, behind: 0, files: [] });
  if (url.pathname === '/api/git/branches') return Response.json({ current: 'main', all: ['main'], branches: { main: { name: 'main', current: true } } });
  if (url.pathname === '/api/git/toplevel') return Response.json({ root: '/repo', prefix: '' });
  if (url.pathname === '/api/git/worktrees' && init?.method === 'POST') {
    worktreeCreates.push({ directory: url.searchParams.get('directory'), body });
    return Response.json({ name: 'fix-thing', branch: 'fix-thing', path: '/repo-worktrees/fix-thing', bootstrapStatus: { status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 } });
  }
  if (url.pathname === '/api/git/worktrees/bootstrap-status') {
    operationOrder.push(`wait:${url.searchParams.get('directory')}`);
    markBootstrapStarted();
    await bootstrapGate;
    bootstrapReady = true;
    return Response.json(readyBootstrap);
  }
  if (/^\/api\/projects\/[^/]+\/config$/.test(url.pathname)) return Response.json({
    trust: { hash: null, trusted: true }, setupWorktree: [], setupWorktreeWait: waitForWorktreeSetup,
    projectActions: [], projectActionsPrimaryId: null, draftStarters: [],
    shared: { status: 'missing', path: '.openchamber/project.json', setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null },
    personal: { setupWorktree: [], setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: [], projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
  });
  if (url.pathname === '/api/session-knowledge/sync') return Response.json({});
  if (url.pathname === '/api/config/snippets') return Response.json({ snippets: [] });
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  if (url.pathname === '/api/fs/directory-stats') return Response.json({ results: [{ path: '/repo', isDirectory: true }] });
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});

const { opencodeClient } = await import('@/lib/opencode/client');
const { useProjectsStore } = await import('./useProjectsStore');
const { useConfigStore } = await import('./useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('./useGlobalSessionsStore');
const { useMultiRunStore } = await import('./useMultiRunStore');
let childStores = new ChildStoreManager();
let loader = new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() });
let testRuntime = 0;
const upsertedSessions = () => useGlobalSessionsStore.getState().activeSessions;
const run = (isolateRuns = false, count = 1) => useMultiRunStore.getState().createMultiRun({
  name: 'Fix thing', isolateRuns,
  groups: [{ prompt: 'Fix it', models: Array.from({ length: count }, (_, index) => ({ providerID: 'p', modelID: `model-${index}` })) }],
});
const goalRun = {
  name: 'Goal run', isolateRuns: false, goal: { tokenBudget: 1000 },
  groups: [
    { prompt: 'Variant A', models: [{ providerID: 'p', modelID: 'one' }] },
    { prompt: 'Variant B', models: [{ providerID: 'p', modelID: 'two' }] },
  ],
};
const settleDispatch = async () => {
  for (let step = 0; step < 10; step += 1) await environment.settle();
};
beforeEach(async () => {
  loader.dispose();
  childStores.disposeAll();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://local.test', runtimeKey: `multirun-test-${++testRuntime}` });
  opencodeClient.reconnectToRuntimeBaseUrl();
  await environment.settle();
  useProjectsStore.setState({ activeProjectId: 'project-1', projects: [{ id: 'project-1', path: '/repo' }] });
  opencodeClient.setDirectory('/repo');
  useConfigStore.setState({ isConnected: true });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.setState({ worktreeMetadata: new Map(), availableWorktreesByProject: new Map(), availableWorktrees: [] });
  childStores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), childStores, '/repo', (sessionID, directory) => registeredDirectories.push({ sessionID, directory }));
  setActionRefs(childStores, () => '/repo');
  loader = new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() });
  setOptimisticRefs(
    (input) => loader.optimisticAdd({ ...input, directory: input.directory || '/repo' }),
    (input) => loader.optimisticRemove({ ...input, directory: input.directory || '/repo' }),
    (input) => loader.optimisticConfirm({ ...input, directory: input.directory || '/repo' }),
  );
  registeredDirectories.length = worktreeCreates.length = operationOrder.length = dispatchedSessionIds.length = deletedSessionIds.length = goalWrites.length = clearedGoals.length = 0;
  dispatchedParts.clear();
  sessions.clear();
  objectiveFiles.clear();
  rejectGoalFor = rejectPromptFor = null;
  createdCount = 0;
  rejectNextMembership = isGitRepository = waitForWorktreeSetup = bootstrapReady = false;
  onCreate = () => {};
  bootstrapGate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  bootstrapStarted = new Promise<void>((resolve) => { markBootstrapStarted = resolve; });
  useMultiRunStore.setState({ isLoading: false, error: null });
});
afterEach(async () => {
  releaseBootstrap();
  await settleDispatch();
});
environment.cleanup(() => { loader.dispose(); childStores.disposeAll(); });

describe('useMultiRunStore', () => {
  test('registers created sessions without waiting for a sidebar refresh', async () => {
    expect((await run())?.sessionIds).toEqual(['ses_multirun']);
    expect(upsertedSessions().map((session) => session.id)).toEqual(['ses_multirun']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo' }]);
    expect([...childStores.children.keys()]).toEqual(['/repo']);
    expect(childStores.getState('/repo')?.session.map((session) => session.id)).toEqual(['ses_multirun']);
  });
  test('membership failure does not dispatch that session or discard a successful sibling', async () => {
    rejectNextMembership = true;
    const result = await run(false, 2);
    await settleDispatch();
    expect(result?.sessionIds).toEqual(['ses_multirun_2']);
    expect(result?.failedCount).toBe(1);
    expect(deletedSessionIds).toEqual(['ses_multirun']);
    expect(dispatchedSessionIds).toEqual(['ses_multirun_2']);
    expect(upsertedSessions().map((session) => session.id)).toEqual(['ses_multirun_2']);
  });
  test('changing runtime while creating stops dispatch and registration', async () => {
    onCreate = () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://other.test', runtimeKey: 'other' });
      opencodeClient.reconnectToRuntimeBaseUrl();
      useMultiRunStore.getState().resetForRuntimeSwitch();
    };
    expect(await run()).toBeNull();
    expect(dispatchedSessionIds).toEqual([]);
    expect(upsertedSessions()).toEqual([]);
    expect(deletedSessionIds).toEqual([]);
    expect(useMultiRunStore.getState().isLoading).toBe(false);
  });
  test('uses fast background worktree creation for isolated runs', async () => {
    isGitRepository = true;
    expect((await run(true))?.sessionIds).toEqual(['ses_multirun']);
    expect(worktreeCreates).toHaveLength(1);
    expect(worktreeCreates[0]?.directory).toBe('/repo');
    expect(worktreeCreates[0]?.body.returnAfterDirectoryCreated).toBe(true);
    expect(worktreeCreates[0]?.body.setUpstream).toBeUndefined();
    expect(bootstrapReady).toBe(false);
    expect(upsertedSessions()[0]?.directory).toBe('/repo-worktrees/fix-thing');
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo-worktrees/fix-thing' }]);
    expect(useSessionUIStore.getState().worktreeMetadata.get('ses_multirun')?.path).toBe('/repo-worktrees/fix-thing');
  });
  test('waits for isolated worktree bootstrap when setup wait is enabled', async () => {
    isGitRepository = waitForWorktreeSetup = true;
    const creating = run(true);
    await bootstrapStarted;
    try {
      await settleDispatch();
      expect(createdCount).toBe(0);
      expect(useMultiRunStore.getState().isLoading).toBe(true);
    } finally {
      releaseBootstrap();
    }
    expect((await creating)?.sessionIds).toEqual(['ses_multirun']);
    expect(bootstrapReady).toBe(true);
    expect(operationOrder.indexOf('wait:/repo-worktrees/fix-thing')).toBeLessThan(operationOrder.indexOf('createSession:/repo-worktrees/fix-thing'));
  });
  test('accepts more than 5 models per group without a "maximum 5 models" error', async () => {
    expect((await run(false, 6))?.sessionIds).toHaveLength(6);
    expect(useMultiRunStore.getState().error).toBeNull();
  });
  test('accepts more than 5 models on the isolated (per-worktree) dispatch path', async () => {
    isGitRepository = true;
    expect((await run(true, 6))?.sessionIds).toHaveLength(6);
    expect(useMultiRunStore.getState().error).toBeNull();
    expect(worktreeCreates).toHaveLength(6);
  });
  test('each lane gets its own goal, from its own prompt, before that prompt leaves', async () => {
    await useMultiRunStore.getState().createMultiRun(goalRun);
    await settleDispatch();
    expect(goalWrites).toEqual([
      { sessionId: 'ses_multirun', directory: '/repo', objective: 'Variant A', tokenBudget: 1000 },
      { sessionId: 'ses_multirun_2', directory: '/repo', objective: 'Variant B', tokenBudget: 1000 },
    ]);
    for (const sessionId of ['ses_multirun', 'ses_multirun_2']) {
      expect(operationOrder.indexOf(`goal:${sessionId}`)).toBeLessThan(operationOrder.indexOf(`prompt:${sessionId}`));
      expect(dispatchedParts.get(sessionId)).toHaveLength(1);
      expect(dispatchedParts.get(sessionId)?.[0]?.text).toContain('A token budget of 1000 tokens');
      expect(dispatchedParts.get(sessionId)?.[0]?.synthetic).toBe(true);
    }
  });
  test('a lane whose goal cannot be written is not sent, its sibling still runs', async () => {
    rejectGoalFor = 'ses_multirun';
    await useMultiRunStore.getState().createMultiRun(goalRun);
    await settleDispatch();
    expect(dispatchedSessionIds).toEqual(['ses_multirun_2']);
  });
  test('a rejected prompt takes its goal back, so the lane does not stay working', async () => {
    rejectPromptFor = 'ses_multirun';
    await useMultiRunStore.getState().createMultiRun(goalRun);
    await settleDispatch();
    expect(clearedGoals).toEqual(['ses_multirun']);
    expect(dispatchedSessionIds).toEqual(['ses_multirun_2']);
  });
  test('a run without a goal writes none', async () => {
    await useMultiRunStore.getState().createMultiRun({ ...goalRun, goal: undefined });
    await settleDispatch();
    expect(goalWrites).toEqual([]);
    expect(dispatchedParts.get('ses_multirun')).toBeUndefined();
  });
});
