import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemon } from './daemon.js';
import { layout } from './state.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it('keeps the check endpoint alive when network tooling is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-daemon-')); roots.push(root);
  const missing = Object.assign(new Error('Install iproute2 system-wide'), { code: 'ip_missing' });
  const system = { ipPath: vi.fn(async () => { throw missing; }) };
  const daemon = await createDaemon({ paths: layout(root), system });
  expect(system.ipPath).not.toHaveBeenCalled();
  // The requirement check runs in this process even if activation cannot run a lifecycle op.
  expect(await daemon.request({ op: 'check' })).toMatchObject({ available: false, message: expect.any(String) });
  await expect(daemon.request({ op: 'create' })).rejects.toMatchObject({ code: 'ip_missing' });
});

it('answers the root operations from the root component and never starts a root space without its check', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-daemon-')); roots.push(root);
  const rootOps = { handle: vi.fn(async () => ({ available: false, reason: 'agent_separation_missing', passkeys: [] })), authorize: vi.fn(async () => { throw Object.assign(new Error('blocked'), { code: 'root_activation_required' }); }) };
  const system = { ipPath: vi.fn(async () => '/usr/bin/ip'), run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) };
  const daemon = await createDaemon({ paths: layout(root), system, rootOps });
  expect(await daemon.request({ op: 'root-status' })).toMatchObject({ reason: 'agent_separation_missing' });
  expect(rootOps.handle).toHaveBeenCalledWith({ op: 'root-status' });
  await daemon.state.save({ id: '123456abcdef', place: 'host-root', name: 'root', project: '1234567890abcdef', created: '2026-11-06T00:00:00.000Z', memoryBytes: 1024 ** 3 });
  const assertion = { id: 'credential' };
  await expect(daemon.request({ op: 'start', place: 'host-root', id: '123456abcdef', assertion })).rejects.toMatchObject({ code: 'root_activation_required' });
  expect(rootOps.authorize).toHaveBeenCalledWith(expect.objectContaining({ op: 'start', id: '123456abcdef', assertion }));
  expect(system.run).not.toHaveBeenCalled();
});

it('reaches into a running root space only while the accounts are still separate', async () => {
  // Given a root space hostd recorded, its units active, after a rollback or reinstall onto one account.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-daemon-')); roots.push(root);
  let separate = false;
  const rootOps = { handle: vi.fn(), authorize: vi.fn(), separation: vi.fn(async () => (separate ? { human: {}, front: {}, agent: {} } : null)) };
  const system = { run: vi.fn(async () => ({ code: 0, stdout: 'ActiveState=active\nReadOnlyPaths=\n', stderr: '' })) };
  const daemon = await createDaemon({ paths: layout(root), system, rootOps });
  await daemon.state.save({ id: '123456abcdef', place: 'host-root', name: 'root', project: '1234567890abcdef', created: '2026-11-06T00:00:00.000Z', memoryBytes: 1024 ** 3 });
  // When the human's account asks to run a command in it or attach to it.
  for (const request of [{ op: 'exec', place: 'host-root', id: '123456abcdef', target: 'space', argv: ['id'] }, { op: 'attach', place: 'host-root', id: '123456abcdef' }]) {
    // Then hostd refuses before it looks at the space.
    await expect(daemon.request(request, {})).rejects.toMatchObject({ code: 'agent_separation_missing' });
  }
  expect(system.run).not.toHaveBeenCalled();
  // And with the accounts separate again, the same request reaches the executor.
  separate = true;
  const executor = vi.spyOn(daemon.executor, 'run').mockResolvedValue({ code: 0 });
  await daemon.request({ op: 'attach', place: 'host-root', id: '123456abcdef' }, {});
  expect(executor).toHaveBeenCalledOnce();
});
