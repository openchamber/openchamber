import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import type { SourceControlReadContext, SourceControlRepositoryRemote } from '@openchamber/ui/lib/api/types';

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

const { createVSCodeSourceControlAPI, VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE } = await import('./source-control');
const identity = { provider: 'github', instance: 'github.com' } as const;
const readContext: SourceControlReadContext = {
  ...identity, directory: '/workspace/repo', repositoryId: 'vscode:/workspace/repo', accountId: 'none', bindingRevision: 1, primaryRemote: 'origin',
};

describe('createVSCodeSourceControlAPI', () => {
  beforeEach(() => { messages.length = 0; });

  test('projects the repository remotes as a ready system-transport binding', async () => {
    const api = createVSCodeSourceControlAPI();
    const reading = api.repositoryBinding('/workspace/repo');
    const message = await nextMessage();
    assert.equal(message.type, 'api:git/remotes');
    assert.deepEqual(message.payload, { directory: '/workspace/repo' });
    respond(message, [
      { name: 'origin', fetchUrl: 'https://user:secret@example.com/team/repo.git', pushUrl: 'https://user:secret@example.com/team/repo.git' },
      { name: 'fork', fetchUrl: 'git@example.com:me/repo.git', pushUrl: 'git@example.com:me/repo.git' },
    ]);
    const read = await reading;
    assert.equal(read.status, 'bound');
    assert.ok(read.binding);
    assert.equal(read.repository.repositoryId, 'vscode:/workspace/repo');
    assert.equal(read.binding.repositoryId, read.repository.repositoryId);
    assert.equal(read.binding.configRevision, read.repository.configRevision);
    assert.deepEqual(read.binding.providers, []);
    assert.deepEqual(read.binding.auxiliary, []);
    assert.deepEqual(read.repository.remotes.map((remote) => remote.fetch.displayUrl), [
      'https://example.com/team/repo.git', 'git@example.com:me/repo.git',
    ]);
    assert.deepEqual(read.binding.remotes.map((remote) => [remote.name, remote.mode, remote.readiness]), [
      ['origin', 'system', 'ready'], ['fork', 'system', 'ready'],
    ]);
    for (const remote of read.binding.remotes) {
      const current: SourceControlRepositoryRemote | undefined = read.repository.remotes.find((entry) => entry.name === remote.name);
      assert.ok(current);
      assert.equal(remote.fetch.fingerprint, current.fetch.fingerprint);
      assert.equal(remote.push.fingerprint, current.push.fingerprint);
    }
  });

  test('config revision follows remote topology and the context rejects an empty directory', async () => {
    const api = createVSCodeSourceControlAPI();
    const first = api.repositoryContext('/workspace/repo');
    respond(await nextMessage(), [{ name: 'origin', fetchUrl: 'https://example.com/a.git', pushUrl: 'https://example.com/a.git' }]);
    const second = api.repositoryContext('/workspace/repo');
    respond(await nextMessage(), [{ name: 'origin', fetchUrl: 'https://example.com/b.git', pushUrl: 'https://example.com/b.git' }]);
    assert.notEqual((await first).configRevision, (await second).configRevision);
    await assert.rejects(api.repositoryContext('  '), /Directory is required/);
    assert.equal(messages.length, 0);
  });

  test('providers stay unsupported and never reach the bridge', async () => {
    const api = createVSCodeSourceControlAPI();
    assert.deepEqual(await api.authInstances(), [identity]);
    const capabilities = await api.capabilities(identity);
    assert.equal(capabilities.authentication, false);
    assert.equal(capabilities.changeRequests, false);
    const status = await api.authStatus(identity);
    assert.equal(status.status, 'unsupported');
    await assert.rejects(api.issuesList(readContext, { page: 1 }), new RegExp(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE));
    await assert.rejects(api.changeRequestsList(readContext, { page: 1 }), new RegExp(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE));
    assert.equal(messages.length, 0);
  });
});
