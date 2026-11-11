import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { GitNetworkOperationRequestError } from '@openchamber/ui/lib/api/types';
import type { GitNetworkOperationRequest } from '@openchamber/ui/lib/api/types';

const listeners = new EventTarget();
const messages: Array<{ id: string; type: string; payload?: unknown }> = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener: listeners.addEventListener.bind(listeners) },
});
Object.defineProperty(globalThis, 'acquireVsCodeApi', {
  configurable: true,
  value: () => ({
    postMessage: (message: { id: string; type: string; payload?: unknown }) => messages.push(message),
    getState: () => undefined,
    setState: () => undefined,
  }),
});

const respond = <Data>(request: { id: string; type: string }, data: Data): void => {
  listeners.dispatchEvent(new MessageEvent('message', {
    data: { id: request.id, type: request.type, success: true, data },
  }));
};

// The bridge announces `webview:ready` once, before its first request. It is
// the host handshake, not the request these tests follow, so it is skipped.
const nextMessage = async () => {
  for (let attempt = 0; attempt < 20 && messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  if (messages[0]?.type === 'webview:ready') messages.shift();
  for (let attempt = 0; attempt < 20 && messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const message = messages.shift();
  assert.ok(message, 'expected a bridge message');
  return message;
};

const REMOTE_URL = 'https://example.com/team/repo.git';
const remotesFixture = [
  { name: 'origin', fetchUrl: REMOTE_URL, pushUrl: REMOTE_URL },
  { name: 'fork', fetchUrl: REMOTE_URL, pushUrl: REMOTE_URL },
];

const { createVSCodeGitAPI } = await import('./git');
const { readRepositoryContext } = await import('./git-remotes');

const contextRead = readRepositoryContext('/workspace/repo');
respond(await nextMessage(), remotesFixture);
const plannedContext = await contextRead;
const endpoint = plannedContext.remotes[0].fetch;
const authority = {
  directory: '/workspace/repo', repositoryId: plannedContext.repositoryId, bindingRevision: 1, configRevision: plannedContext.configRevision,
};

// Execution first re-reads the remotes to confirm the plan still matches them.
const answerRevalidation = async (remotes = remotesFixture) => {
  const message = await nextMessage();
  assert.equal(message.type, 'api:git/remotes');
  respond(message, remotes);
};

describe('createVSCodeGitAPI network operations', () => {
  beforeEach(() => { messages.length = 0; });

  test('plans a deletion as a system-transport plan without touching the extension host', async () => {
    const git = createVSCodeGitAPI();
    const request: GitNetworkOperationRequest = {
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    };
    const plan = await git.planNetworkOperation(request);
    assert.equal(plan.state, 'planned');
    assert.deepEqual(plan.transport, { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } });
    assert.deepEqual(plan.target, {
      operation: 'delete-remote-branch', repositoryId: authority.repositoryId, bindingRevision: 1,
      configRevision: authority.configRevision, remote: request.remote, destinationRef: 'refs/heads/stale',
    });
    assert.equal(messages.length, 0, 'planning must not touch the extension host');
  });

  test('push, pull, fetch and sync are rejected as unsupported at planning', async () => {
    const git = createVSCodeGitAPI();
    const remote = { name: 'origin', endpoint };
    const requests: GitNetworkOperationRequest[] = [
      { ...authority, operation: 'push', remote, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system' },
      { ...authority, operation: 'pull', remote, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system' },
      { ...authority, operation: 'fetch', fetchScope: 'remote', remote, transportMode: 'system' },
      {
        ...authority, operation: 'sync',
        fetch: { remote, sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/origin/main', transportMode: 'system' },
        pull: { destinationRef: 'refs/heads/main' },
        push: { remote, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system' },
      },
    ];
    for (const request of requests) {
      await assert.rejects(git.planNetworkOperation(request), (error: unknown) => (
        error instanceof GitNetworkOperationRequestError && error.code === 'RUNTIME_UNSUPPORTED' && error.status === 501
      ));
    }
    assert.equal(messages.length, 0);
  });

  test('remote branch deletion uses the standard remote-branches message', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    await answerRevalidation();
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/remote-branches');
    assert.deepEqual(message.payload, { directory: '/workspace/repo', remote: 'origin', branch: 'stale' });
    respond(message, { success: false });
    assert.equal((await executing).state, 'failed');
  });

  test('a remote whose push URL changed after planning ends conflicted without running Git', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint: plannedContext.remotes[0].push },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    await answerRevalidation([{ name: 'origin', fetchUrl: REMOTE_URL, pushUrl: 'https://other.example.com/team/repo.git' }, remotesFixture[1]]);
    const result = await executing;
    assert.equal(result.state, 'conflicted');
    assert.ok('error' in result);
    assert.equal(result.error.code, 'REMOTE_CHANGED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(messages.length, 0, 'no Git command may run against the changed remote');
  });

  test('a slow transfer stays running past the bridge timeout and settles with the host answer', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    const revalidation = await nextMessage();
    // Fake timers start before the deletion request exists, so its bridge timeout,
    // if one were armed, would fire on the tick below.
    mock.timers.enable({ apis: ['setTimeout'] });
    let deletion: (typeof messages)[number] | undefined;
    try {
      respond(revalidation, remotesFixture);
      for (let attempt = 0; attempt < 50 && !deletion; attempt += 1) {
        await Promise.resolve();
        deletion = messages.find((message) => message.type === 'api:git/remote-branches');
      }
      assert.ok(deletion, 'expected the deletion request');
      mock.timers.tick(10 * 60 * 1000);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await git.getNetworkOperation(plan.operationId)).state, 'running');
    respond(deletion, { success: true });
    assert.equal((await executing).state, 'succeeded');
  });

  test('cancel before execution, unknown IDs, non-system transport and unsupported operations fail explicitly', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    });
    const cancelled = await git.cancelNetworkOperation(plan.operationId);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(await git.executeNetworkOperation(plan.operationId), cancelled);
    assert.equal(messages.length, 0);

    await assert.rejects(git.getNetworkOperation('missing'), (error: unknown) => (
      error instanceof GitNetworkOperationRequestError && error.code === 'NOT_FOUND' && error.status === 404
    ));
    await assert.rejects(git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'managed',
    }), (error: unknown) => error instanceof GitNetworkOperationRequestError && error.code === 'INVALID_REQUEST');
    await assert.rejects(git.planNetworkOperation({
      operation: 'clone', remoteUrl: 'https://example.com/repo.git', destinationPath: '/tmp/repo',
      transportMode: 'system', unverifiedConfirmed: true,
    }), (error: unknown) => error instanceof GitNetworkOperationRequestError && error.code === 'RUNTIME_UNSUPPORTED' && error.status === 501);
    assert.deepEqual(await git.listContributorDestinations('/workspace/repo'), { kind: 'ordinary' });
    assert.ok(git.validateGitWorktree);
    await assert.rejects(git.validateGitWorktree('/workspace/repo', { mode: 'new', branchName: 'x', ensureRemoteUrl: 'https://example.com/fork.git' }),
      (error: unknown) => error instanceof GitNetworkOperationRequestError && error.code === 'RUNTIME_UNSUPPORTED');
  });
});

describe('createVSCodeGitAPI worktree removal', () => {
  beforeEach(() => { messages.length = 0; });

  test('a delete and a teardown wait for the extension host as long as its teardown runs', async () => {
    const git = createVSCodeGitAPI();
    assert.ok(git.worktree?.remove && git.worktree.teardown && git.deleteGitWorktree);
    // Fake timers start before the requests exist, so a bridge timeout, if one
    // were armed, would fire on the tick below.
    mock.timers.enable({ apis: ['setTimeout'] });
    let calls: Array<Promise<{ success: boolean }>>;
    try {
      calls = [
        git.worktree.remove('/workspace/repo', { directory: '/workspace/wt', teardownCommand: 'docker compose down' }),
        git.deleteGitWorktree('/workspace/repo', { directory: '/workspace/wt', teardownCommand: 'docker compose down' }),
        git.worktree.teardown('/workspace/repo', { directory: '/workspace/wt', teardownCommand: 'docker compose down' }),
      ];
      mock.timers.tick(10 * 60 * 1000);
    } finally {
      mock.timers.reset();
    }
    const requests = messages.filter((message) => message.type.startsWith('api:git/worktrees'));
    assert.deepEqual(requests.map((message) => message.type), ['api:git/worktrees', 'api:git/worktrees', 'api:git/worktrees/teardown']);
    assert.deepEqual(requests[2].payload, { directory: '/workspace/repo', worktreeDirectory: '/workspace/wt', teardownCommand: 'docker compose down' });
    for (const request of requests) respond(request, { success: true });
    assert.deepEqual(await Promise.all(calls), [{ success: true }, { success: true }, { success: true }]);
  });
});

describe('createVSCodeGitAPI author profiles and remotes', () => {
  beforeEach(() => { messages.length = 0; });

  test('keeps profiles in webview memory for the lifetime of the view', async () => {
    const git = createVSCodeGitAPI();
    const profile = { id: 'work', name: 'Work', userName: 'Author', userEmail: 'author@example.com', signCommits: true, signingKey: 'ssh-ed25519 AAAA' };
    assert.deepEqual(await git.getGitIdentities(), []);
    assert.deepEqual(await git.createGitIdentity(profile), profile);
    assert.deepEqual(await git.getGitIdentities(), [profile]);
    assert.deepEqual(await createVSCodeGitAPI().getGitIdentities(), [profile], 'profiles are shared across adapter instances in one view');

    await assert.rejects(git.updateGitIdentity('other', profile), /does not match/);
    await git.deleteGitIdentity('work');
    assert.deepEqual(await git.getGitIdentities(), []);
  });

  test('redacts userinfo from remote URLs', async () => {
    const git = createVSCodeGitAPI();
    const reading = git.getRemotes('/workspace/repo');
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/remotes');
    respond(message, [
      { name: 'origin', fetchUrl: 'https://user:token@example.com/team/repo.git?x=1', pushUrl: 'git@example.com:team/repo.git' },
    ]);
    assert.deepEqual(await reading, [
      { name: 'origin', fetchUrl: 'https://example.com/team/repo.git', pushUrl: 'git@example.com:team/repo.git' },
    ]);
  });
});

describe('createVSCodeGitAPI repository check', () => {
  test("turns the extension's GIT_REPOSITORY_UNREADABLE into the shared error with Git's message", async () => {
    messages.length = 0;
    const { GitRepositoryUnreadableError } = await import('@openchamber/ui/lib/gitRepositoryUnreadable');
    const git = createVSCodeGitAPI();
    const checking = git.checkIsGitRepository('/repo');
    const request = await nextMessage();
    assert.equal(request.type, 'api:git/check');
    const message = "fatal: detected dubious ownership in repository at '/repo'";
    listeners.dispatchEvent(new MessageEvent('message', {
      data: { id: request.id, type: request.type, success: false, error: message, code: 'GIT_REPOSITORY_UNREADABLE' },
    }));
    await assert.rejects(checking, (error) => error instanceof GitRepositoryUnreadableError && error.message === message);
  });
});
