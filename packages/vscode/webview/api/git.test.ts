import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
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

const reject = (request: { id: string; type: string }, error: string): void => {
  listeners.dispatchEvent(new MessageEvent('message', {
    data: { id: request.id, type: request.type, success: false, error },
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

const endpoint = { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'fp' };
const authority = { directory: '/workspace/repo', repositoryId: 'vscode:/workspace/repo', bindingRevision: 1, configRevision: 'remotes-1' };

const { createVSCodeGitAPI } = await import('./git');

describe('createVSCodeGitAPI network operations', () => {
  beforeEach(() => { messages.length = 0; });

  test('plans a push as a system-transport plan and executes it through the standard push message', async () => {
    const git = createVSCodeGitAPI();
    const request: GitNetworkOperationRequest = {
      ...authority, operation: 'push', remote: { name: 'origin', endpoint },
      sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature', transportMode: 'system', configureUpstream: true,
    };
    const plan = await git.planNetworkOperation(request);
    assert.equal(plan.state, 'planned');
    assert.deepEqual(plan.transport, { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } });
    assert.deepEqual(plan.target, {
      operation: 'push', repositoryId: authority.repositoryId, bindingRevision: 1, configRevision: 'remotes-1',
      remote: request.remote, sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature', configureUpstream: true,
    });
    assert.equal(messages.length, 0, 'planning must not touch the extension host');

    const executing = git.executeNetworkOperation(plan.operationId);
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/push');
    assert.deepEqual(message.payload, { directory: '/workspace/repo', remote: 'origin', branch: 'feature', options: ['--set-upstream'] });
    respond(message, { success: true, pushed: [{ local: 'feature', remote: 'origin' }], repo: '/workspace/repo', ref: null });
    const result = await executing;
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(result.completedSteps, ['validated', 'transferred']);
    assert.deepEqual(await git.getNetworkOperation(plan.operationId), result);
  });

  test('pushes to a differently named remote branch with a refspec and force-with-lease', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'push', remote: { name: 'fork', endpoint },
      sourceRef: 'refs/heads/local', destinationRef: 'refs/heads/remote', transportMode: 'system',
      forceWithLease: { expectedRemoteSha: 'abc123' },
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    const message = await nextMessage();
    assert.deepEqual(message.payload, {
      directory: '/workspace/repo', remote: 'fork', branch: 'local:remote', options: ['--force-with-lease=remote:abc123'],
    });
    respond(message, { success: true, pushed: [], repo: '/workspace/repo', ref: null });
    assert.equal((await executing).state, 'succeeded');
  });

  test('remote-scope fetch omits the branch and a failed bridge call becomes a failed operation', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'fetch', fetchScope: 'remote', remote: { name: 'origin', endpoint }, transportMode: 'system',
    });
    assert.deepEqual(plan.target, {
      operation: 'fetch', fetchScope: 'remote', repositoryId: authority.repositoryId, bindingRevision: 1,
      configRevision: 'remotes-1', remote: { name: 'origin', endpoint }, force: false,
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/fetch');
    assert.deepEqual(message.payload, { directory: '/workspace/repo', remote: 'origin' });
    reject(message, 'could not read from remote');
    const result = await executing;
    assert.equal(result.state, 'failed');
    assert.ok('error' in result);
    assert.deepEqual(result.error, { code: 'TRANSPORT_FAILED', message: 'could not read from remote' });
  });

  test('sync runs fetch, pull and push in order and records step results', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'sync',
      fetch: { remote: { name: 'origin', endpoint }, sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/origin/main', transportMode: 'system' },
      pull: { destinationRef: 'refs/heads/main' },
      push: { remote: { name: 'origin', endpoint }, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system' },
    });
    assert.deepEqual(plan.transport, {
      fetch: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
      push: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    const fetch = await nextMessage();
    assert.equal(fetch.type, 'api:git/fetch');
    respond(fetch, { success: true });
    const pull = await nextMessage();
    assert.equal(pull.type, 'api:git/pull');
    assert.deepEqual(pull.payload, { directory: '/workspace/repo', remote: 'origin', branch: 'main' });
    respond(pull, { success: true, summary: { changes: 0, insertions: 0, deletions: 0 }, files: [], insertions: 0, deletions: 0 });
    const push = await nextMessage();
    assert.equal(push.type, 'api:git/push');
    reject(push, 'rejected');
    const result = await executing;
    assert.equal(result.state, 'partial');
    assert.deepEqual(result.stepResults, [
      { step: 'fetch', status: 'succeeded' },
      { step: 'pull', status: 'succeeded' },
      { step: 'push', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'rejected' } },
    ]);
  });

  test('remote branch deletion uses the standard remote-branches message', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'delete-remote-branch', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/stale', transportMode: 'system',
    });
    const executing = git.executeNetworkOperation(plan.operationId);
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/remote-branches');
    assert.deepEqual(message.payload, { directory: '/workspace/repo', remote: 'origin', branch: 'stale' });
    respond(message, { success: false });
    assert.equal((await executing).state, 'failed');
  });

  test('cancel before execution, unknown IDs, non-system transport and unsupported operations fail explicitly', async () => {
    const git = createVSCodeGitAPI();
    const plan = await git.planNetworkOperation({
      ...authority, operation: 'pull', remote: { name: 'origin', endpoint },
      sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system',
    });
    const cancelled = await git.cancelNetworkOperation(plan.operationId);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(await git.executeNetworkOperation(plan.operationId), cancelled);
    assert.equal(messages.length, 0);

    await assert.rejects(git.getNetworkOperation('missing'), (error: unknown) => (
      error instanceof GitNetworkOperationRequestError && error.code === 'NOT_FOUND' && error.status === 404
    ));
    await assert.rejects(git.planNetworkOperation({
      ...authority, operation: 'pull', remote: { name: 'origin', endpoint },
      sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'managed',
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

describe('createVSCodeGitAPI author profiles and remotes', () => {
  beforeEach(() => { messages.length = 0; });

  test('keeps profiles in the webview and applies them through the standard identity message', async () => {
    const git = createVSCodeGitAPI();
    const profile = { id: 'work', name: 'Work', userName: 'Author', userEmail: 'author@example.com', signCommits: true, signingKey: 'ssh-ed25519 AAAA' };
    assert.deepEqual(await git.getGitIdentities(), []);
    assert.deepEqual(await git.createGitIdentity(profile), profile);
    assert.deepEqual(await git.getGitIdentities(), [profile]);
    assert.deepEqual(await createVSCodeGitAPI().getGitIdentities(), [profile], 'profiles are shared across adapter instances in one view');

    const applying = git.setGitIdentity('/workspace/repo', 'work');
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/identity');
    assert.deepEqual(message.payload, {
      directory: '/workspace/repo', method: 'POST', userName: 'Author', userEmail: 'author@example.com',
      signCommits: true, signingKey: 'ssh-ed25519 AAAA',
    });
    respond(message, { success: true });
    assert.deepEqual(await applying, { success: true, profile });

    await assert.rejects(git.setGitIdentity('/workspace/repo', 'missing'), /not found/);
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
