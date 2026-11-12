import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycle, prepareMcpSubjectFolder } from './lifecycle.js';
import { layout } from './state.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const request = { op: 'create', place: 'host', spec: { id: 'aabbcc112233', name: 'test', project: '1234567890abcdef', created: '2026-11-06T00:00:00.000Z', memoryBytes: 1024 ** 3 }, toolsKey: '1234567890abcdef', startConfig: null };

describe('host lifecycle ownership', () => {
  const fixture = async (collision) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-lifecycle-')); roots.push(root);
    const state = { read: async () => null, list: async () => [], save: vi.fn(async () => { throw new Error('reached metadata creation'); }) };
    const system = { run: vi.fn(async (file, args) => {
      if (file === '/usr/bin/systemctl') {
        const name = args.at(-1);
        const stdout = name === collision ? 'LoadState=loaded\nFragmentPath=/etc/systemd/system/foreign.service\nActiveState=inactive\n'
          : name.endsWith('.slice') ? 'LoadState=loaded\nFragmentPath=\nDropInPaths=\nActiveState=inactive\n'
            : 'LoadState=not-found\n';
        return { code: 0, stdout, stderr: '' };
      }
      return file === '/usr/bin/getent' ? { code: 2, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Device does not exist' };
    }) };
    const lifecycle = createLifecycle({ system, paths: layout(root), state, tools: { ready: async () => true }, network: {}, executor: {}, ipPath: '/usr/bin/ip', authorizeRoot: async () => {} });
    return { lifecycle, state, system };
  };
  it('refuses a pre-existing unit before authorizing any deletion or metadata adoption', async () => {
    const { lifecycle, state, system } = await fixture('openchamber-gk-aabbcc112233.service');
    await expect(lifecycle.create(request)).rejects.toMatchObject({ code: 'space_name_taken' });
    expect(state.save).not.toHaveBeenCalled();
    expect(system.run.mock.calls.some(([, args]) => args.includes('stop') || args.includes('delete'))).toBe(false);
  });
  it('allows the empty inactive slice systemd synthesizes for a fresh name', async () => {
    const { lifecycle, state } = await fixture(null);
    await expect(lifecycle.create(request)).rejects.toThrow('reached metadata creation');
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ id: request.spec.id, place: 'host', subnet: 0 }));
  });
});

describe('root activation in the host lifecycle', () => {
  const blocked = () => vi.fn(async () => { throw Object.assign(new Error('blocked'), { code: 'root_activation_required' }); });
  const record = { id: '123456abcdef', place: 'host-root' };
  const assertion = { id: 'credential', type: 'public-key' };

  it.each(['create', 'start'])('checks the confirmation of a root %s before anything else, with the assertion it came with', async (op) => {
    const authorizeRoot = blocked();
    // Every other dependency is empty: any step before the check would throw a TypeError instead.
    const lifecycle = createLifecycle({ system: {}, paths: {}, state: {}, tools: {}, network: {}, executor: {}, ipPath: '/usr/bin/ip', authorizeRoot });
    await expect(op === 'create' ? lifecycle.create({ place: 'host-root', spec: record, assertion }) : lifecycle.start(record, { assertion })).rejects.toMatchObject({ code: 'root_activation_required' });
    expect(authorizeRoot).toHaveBeenCalledExactlyOnceWith({ op, id: record.id, spec: record, assertion });
  });

  it('does not exist without the root activation check', () => {
    expect(() => createLifecycle({ system: {}, paths: {}, state: {}, tools: {}, network: {}, executor: {}, ipPath: '/usr/bin/ip' })).toThrow();
  });
});

describe('removing a host space', () => {
  it('leaves systemd nothing of the space: its slice stopped and no failed unit', async () => {
    // Given a space whose server unit failed on stop, as a SIGTERM exit records it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-lifecycle-')); roots.push(root);
    const record = { id: 'aabbcc112233', place: 'host' };
    const system = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) };
    const state = { remove: vi.fn(async () => {}) };
    const lifecycle = createLifecycle({ system, paths: layout(root), state, tools: {}, network: { destroy: async () => {} }, executor: {}, ipPath: '/usr/bin/ip', authorizeRoot: async () => {} });
    // When it is removed.
    await lifecycle.remove(record);
    // Then its slice is stopped and every one of its units is reset, after the unit files are gone.
    const calls = system.run.mock.calls.filter(([file]) => file === '/usr/bin/systemctl').map(([, args]) => args.join(' '));
    const units = ['openchamber-space-aabbcc112233.service', 'openchamber-gk-aabbcc112233.service', 'openchamber-net-aabbcc112233.service', 'openchamber-space-aabbcc112233.slice'];
    expect(calls).toContain('stop openchamber-space-aabbcc112233.slice');
    expect(calls.find((call) => call.startsWith('reset-failed'))?.split(' ').slice(1).sort()).toEqual(units.sort());
    expect(calls.indexOf('daemon-reload')).toBeLessThan(calls.indexOf('stop openchamber-space-aabbcc112233.slice'));
    expect(state.remove).toHaveBeenCalledWith('aabbcc112233');
  });
});

describe('the protected MCP subject of a host space', () => {
  it('is made before the unit binds it, owned and shaped as the other subjects of the service', async () => {
    // Given the service's subjects folder, as the service user owns it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-lifecycle-')); roots.push(root);
    const paths = layout(root);
    await fs.mkdir(paths.mcpSubjects, { recursive: true, mode: 0o700 });
    // When a space starts, and again at its next start.
    await prepareMcpSubjectFolder(paths, 'aabbcc112233');
    await prepareMcpSubjectFolder(paths, 'aabbcc112233');
    // Then its folder is there for the bind, with the service's owner and the mode it gives subjects.
    const folder = await fs.lstat(path.join(paths.mcpSubjects, 'space-aabbcc112233'));
    const subjects = await fs.lstat(paths.mcpSubjects);
    expect(folder.isDirectory()).toBe(true);
    expect([folder.uid, folder.gid, folder.mode & 0o777]).toEqual([subjects.uid, subjects.gid, 0o711]);
  });

  it('is left alone on a host without the service, and refused as a link', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-lifecycle-')); roots.push(root);
    const paths = layout(root);
    await prepareMcpSubjectFolder(paths, 'aabbcc112233');
    expect(await fs.lstat(path.dirname(paths.mcpSubjects)).catch(() => null)).toBeNull();
    await fs.mkdir(paths.mcpSubjects, { recursive: true });
    await fs.symlink('/etc', path.join(paths.mcpSubjects, 'space-aabbcc112233'));
    await expect(prepareMcpSubjectFolder(paths, 'aabbcc112233')).rejects.toMatchObject({ code: 'space_state_unsafe' });
  });
});
