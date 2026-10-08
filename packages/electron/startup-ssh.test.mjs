import assert from 'node:assert/strict';
import test from 'node:test';

import { connectDefaultSshInstanceAtStartup, resolveDefaultSshInstanceId } from './startup-ssh.mjs';

const fakeManager = (connect) => {
  const disconnected = [];
  return {
    disconnected,
    connect,
    disconnect: async (id) => { disconnected.push(id); },
  };
};

test('only an SSH instance id counts as the default SSH instance', () => {
  const instances = [{ id: 'ssh-1' }];
  assert.equal(resolveDefaultSshInstanceId('ssh-1', instances), 'ssh-1');
  assert.equal(resolveDefaultSshInstanceId('local', instances), null);
  assert.equal(resolveDefaultSshInstanceId('', instances), null);
});

test('a ready tunnel resolves ok and keeps the connection', async () => {
  const manager = fakeManager(async () => {});
  assert.deepEqual(await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1' }), { ok: true });
  assert.deepEqual(manager.disconnected, []);
});

test('a failed connect reports why and tears the attempt down', async () => {
  const manager = fakeManager(async () => { throw new Error('Permission denied'); });
  const result = await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1' });
  assert.deepEqual(result, { ok: false, reason: 'Permission denied' });
  assert.deepEqual(manager.disconnected, ['ssh-1']);
});

test('a connect that outlasts the bound is stopped', async () => {
  const manager = fakeManager(() => new Promise(() => {}));
  const result = await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1', timeoutMs: 10 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.deepEqual(manager.disconnected, ['ssh-1']);
});
