import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { isSpaceCreationRequest, startSpaceCreation, type SpaceModelAccess } from './space-creation';
import { spaceModelRefusal } from './space-model-access';
import type { SpaceEntry } from './spaces-api';
import { useSpacesStore } from './spaces-store';
import { isDraftSendWaiting, waitForPendingDraftWorktreeRequest } from '@/lib/worktrees/pendingDraftWorktree';
import { useSessionUIStore } from '@/sync/session-ui-store';

const ID = 'a1b2c3d4e5f6';
const PROJECT = '/home/me/app';
const DIRECTORY = `/spaces/${ID}/app`;
const originalFetch = globalThis.fetch;

const entry: SpaceEntry = {
  id: ID,
  name: 'Fix login',
  projectDirectory: PROJECT,
  projectFolder: { path: PROJECT, found: null },
  directory: DIRECTORY,
  state: 'preparing',
  stoppedIdle: false,
  step: 'checking_place',
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  grants: [],
  access: null,
  needsAccess: [],
  damage: null,
  setup: null,
};

const openai: SpaceModelAccess = { kind: 'model', provider: 'openai', upstream: 'https://api.openai.com/v1', secret: { kind: 'env', name: 'OPENAI_API_KEY' } };

// The host: the creation answers the entry, a grant answers what `grantAnswer` says, and the list
// answers the space running with the grants that went through.
const host = (grantAnswer: { status: number; body: { grant?: unknown; code?: string; message?: string } }, listedSetup: SpaceEntry['setup'] = null, createdSetup: SpaceEntry['setup'] = null) => {
  const grants: unknown[] = [];
  const created: unknown[] = [];
  const given: unknown[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/grants')) {
      grants.push(JSON.parse(String(init?.body)));
      if (grantAnswer.status === 200 && grantAnswer.body.grant) given.push(grantAnswer.body.grant);
      return new Response(JSON.stringify(grantAnswer.body), { status: grantAnswer.status });
    }
    if ((init?.method ?? 'GET') === 'GET') {
      const listed = { ...entry, state: 'running', step: null, grants: given, access: given.length > 0 ? 'granted' : null, setup: listedSetup };
      return new Response(JSON.stringify({ spaces: [listed] }), { status: 200 });
    }
    created.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ...entry, setup: createdSetup }), { status: 202 });
  }, originalFetch);
  return Object.assign(grants, { created });
};

const start = (access: readonly SpaceModelAccess[] = [], setup = { commands: [] as string[], waitBeforeSending: false }) => startSpaceCreation({
  projectId: 'project-1',
  request: { projectDirectory: PROJECT, name: 'Fix login', start: 'clean', network: { mode: 'allowlist', domains: [] } },
  setup,
  access,
  refusalMessage: 'refused',
});

// The draft's waiting message, as `materializeOpenDraftSession` waits for it.
const waitingMessage = () => {
  const requestId = useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId;
  if (!requestId) throw new Error('the draft waits for nothing');
  return { requestId, outcome: waitForPendingDraftWorktreeRequest(requestId).then((directory) => ({ directory }), (error: Error) => ({ error: error.message })) };
};

describe('startSpaceCreation', () => {
  beforeEach(() => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    useSessionUIStore.getState().closeNewSessionDraft();
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('the group appears at once and the draft waits for the space, not a worktree', async () => {
    host({ status: 200, body: {} });
    await start();
    expect(useSpacesStore.getState().journey?.get(ID)?.state).toBe('preparing');
    const { requestId } = waitingMessage();
    expect(isSpaceCreationRequest(requestId)).toBe(true);
    expect(isDraftSendWaiting(requestId)).toBe(false);
  });

  test('the waiting message goes to the space once it is ready and its access given', async () => {
    const grants = host({ status: 200, body: { grant: { kind: 'model', id: 'openai', provider: 'openai', upstream: openai.upstream, source: { kind: 'env', name: 'OPENAI_API_KEY' }, url: 'http://gatekeeper:8080/model/openai' } } });
    await start([openai]);
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    expect(await outcome).toEqual({ directory: DIRECTORY });
    expect(grants).toEqual([openai]);
    expect(useSpacesStore.getState().creationAccess.get(ID)).toBeUndefined();
  });

  test('a draft that had not sent yet stays where the user types, and finds the space when it sends', async () => {
    host({ status: 200, body: {} });
    await start();
    const { requestId } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    await waitForPendingDraftWorktreeRequest(requestId);
    // Moving the draft would move the composer to another directory's draft and hide the text.
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(PROJECT);
    expect(useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId).toBe(requestId);
    expect(await waitForPendingDraftWorktreeRequest(requestId)).toBe(DIRECTORY);
  });

  test('a failed creation gives the message back, and the draft no longer points at the space', async () => {
    host({ status: 200, body: {} });
    await start([openai]);
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'failed', failure: { code: 'docker_daemon_unreachable', message: 'down' } });
    expect(await outcome).toEqual({ error: 'refused' });
    expect(useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId).toBeNull();
  });

  test('a space that leaves the list, or a list that is gone, gives the message back', async () => {
    host({ status: 200, body: {} });
    await start();
    const first = waitingMessage().outcome;
    useSpacesStore.getState().applyJourney([], useSpacesStore.getState().progressRevision);
    expect(await first).toEqual({ error: 'refused' });

    useSessionUIStore.getState().closeNewSessionDraft();
    await start();
    const second = waitingMessage().outcome;
    useSpacesStore.getState().resetForRuntimeSwitch();
    expect(await second).toEqual({ error: 'refused' });
  });

  test('a read that began before the creation does not drop its group', async () => {
    host({ status: 200, body: {} });
    const before = useSpacesStore.getState().progressRevision;
    await start();
    useSpacesStore.getState().applyJourney([], before);
    expect(useSpacesStore.getState().journey?.get(ID)?.state).toBe('preparing');
  });

  test('a message on a model the space was not given is refused while the draft still waits', async () => {
    host({ status: 200, body: {} });
    await start([openai]);
    const { requestId } = waitingMessage();
    expect(spaceModelRefusal({ requestId, directory: PROJECT }, 'google')).toEqual({ spaceId: ID, providerId: 'google', reason: 'not_granted' });
    expect(spaceModelRefusal({ requestId, directory: PROJECT }, 'openai')).toBeNull();
  });

  test('once ready, the list the host read after giving access decides', async () => {
    host({ status: 200, body: { grant: { kind: 'model', id: 'openai', provider: 'openai', upstream: openai.upstream, source: { kind: 'env', name: 'OPENAI_API_KEY' }, url: 'http://gatekeeper:8080/model/openai' } } });
    await start([openai]);
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    await outcome;
    expect(spaceModelRefusal({ requestId: null, directory: DIRECTORY }, 'openai')).toBeNull();
    expect(useSpacesStore.getState().journey?.get(ID)?.grants).toHaveLength(1);
    expect(spaceModelRefusal({ requestId: null, directory: DIRECTORY }, 'google')).toEqual({ spaceId: ID, providerId: 'google', reason: 'not_granted' });
    expect(spaceModelRefusal({ requestId: null, directory: PROJECT }, 'google')).toBeNull();
  });

  test('access that could not be given holds the message back and stays on the group', async () => {
    host({ status: 400, body: { code: 'secret_source_missing', message: 'OPENAI_API_KEY is not set' } });
    await start([openai]);
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    expect(await outcome).toEqual({ error: 'refused' });
    expect(useSpacesStore.getState().creationAccess.get(ID)).toEqual({ kind: 'failed', failures: [{ provider: 'openai', code: 'secret_source_missing', message: 'OPENAI_API_KEY is not set' }] });
  });

  test('the setup commands travel with the request, and the message does not wait for them by default', async () => {
    const { created } = host({ status: 200, body: {} }, { state: 'running', index: 0, total: 1, command: 'npm ci' });
    await start([], { commands: ['npm ci'], waitBeforeSending: false });
    expect(created).toEqual([{ projectDirectory: PROJECT, name: 'Fix login', start: 'clean', network: { mode: 'allowlist', domains: [] }, setupCommands: ['npm ci'] }]);
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    expect(await outcome).toEqual({ directory: DIRECTORY });
  });

  test('with the project\'s wait setting the message waits for the setup commands, and goes when they ended, failed or not', async () => {
    host({ status: 200, body: {} }, null, { state: 'queued', total: 1 });
    await start([], { commands: ['npm ci'], waitBeforeSending: true });
    const { requestId, outcome } = waitingMessage();
    let settled = false;
    void outcome.then(() => { settled = true; });
    const running = { ...entry, state: 'running' as const, step: null, setup: { state: 'running' as const, index: 0, total: 1, command: 'npm ci' } };
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    useSpacesStore.getState().applyJourney([running], useSpacesStore.getState().progressRevision);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(settled).toBe(false);
    useSpacesStore.getState().applyJourney([{ ...running, setup: { state: 'failed', index: 0, total: 1, command: 'npm ci', exitCode: 1, timedOut: false, startedAt: null, finishedAt: null } }], useSpacesStore.getState().progressRevision);
    expect(await outcome).toEqual({ directory: DIRECTORY });
    expect(isSpaceCreationRequest(requestId)).toBe(true);
  });

  test('a host that did not say it will run the setup commands is not waited for, whatever the wait setting', async () => {
    host({ status: 200, body: {} });
    await start([], { commands: ['npm ci'], waitBeforeSending: true });
    const { outcome } = waitingMessage();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    expect(await outcome).toEqual({ directory: DIRECTORY });
  });
});
