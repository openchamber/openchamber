import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectSharing } from './share-project.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A human's home with one project, over a temporary directory this test owns, and a sharing whose
 * setfacl calls are recorded. The test's own account plays the human.
 */
async function setup({ mountInfo = null } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'share-project-')));
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home', 'dev');
  const project = path.join(home, 'workspace', 'app');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'code');
  await fs.writeFile(path.join(project, 'README.md'), 'readme');
  // Above the home folder everyone may cross, as on a real host.
  await fs.chmod(base, 0o755);
  await fs.chmod(path.join(base, 'home'), 0o755);
  await fs.chmod(home, 0o750);
  await fs.chmod(path.join(home, 'workspace'), 0o700);
  const calls = [];
  const sharing = createProjectSharing({
    human: { name: 'dev', uid: process.getuid(), gid: process.getgid(), home },
    agent: { name: 'dev-agent', uid: 2_000_000_002, gid: 2_000_000_002, home: '/home/dev-agent' },
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    },
    statePath: path.join(base, 'state', 'shares.json'),
    readMountInfo: async () => mountInfo ?? `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n`,
  });
  return { base, home, project, calls, sharing };
}

/** The paths each setfacl call got, by the ACL it set or removed. */
const targetsOf = (calls, acl) => calls.filter((call) => call.includes(acl)).flatMap((call) => call.slice(call.indexOf('--') + 1));

describe('sharing a project with the agent', () => {
  it('gives the agent the project tree and a way through the folders above it, and records the share', async () => {
    const { project, home, calls, sharing } = await setup();
    const result = await sharing.share(project);
    expect(result).toMatchObject({ path: project, status: 'shared', failed: [] });
    // Every call is a physical walk: setfacl never follows or changes a link.
    for (const call of calls) expect(call.slice(0, 2)).toEqual(['/usr/bin/setfacl', '-P']);
    expect(targetsOf(calls, 'u:dev-agent:rwX,d:u:dev-agent:rwX,d:u:dev:rwX').sort()).toEqual([project, path.join(project, 'src')].sort());
    expect(targetsOf(calls, 'u:dev-agent:rwX').sort()).toEqual([path.join(project, 'README.md'), path.join(project, 'src', 'index.js')].sort());
    // Only the folders others cannot cross get an entry: here the home and the workspace.
    expect(targetsOf(calls, 'u:dev-agent:--x')).toEqual([path.join(home, 'workspace'), home]);
    expect((await sharing.list()).map((entry) => entry.path)).toEqual([project]);
  });

  it('leaves links, other filesystems and hard-linked files out of the walk', async () => {
    const { project, base, calls, sharing } = await setup();
    const outside = path.join(base, 'secret');
    await fs.writeFile(outside, 'owner secret');
    await fs.symlink(outside, path.join(project, 'link-to-secret'));
    await fs.symlink(path.join(base, 'home'), path.join(project, 'link-to-home'));
    await fs.link(outside, path.join(project, 'hard-link-to-secret'));
    const result = await sharing.share(project);
    const touched = calls.flatMap((call) => call.slice(call.indexOf('--') + 1));
    expect(touched).not.toContain(path.join(project, 'link-to-secret'));
    expect(touched).not.toContain(path.join(project, 'link-to-home'));
    expect(touched).not.toContain(path.join(project, 'hard-link-to-secret'));
    expect(touched).not.toContain(outside);
    expect(result.skipped).toMatchObject({ links: 2, hardLinked: [path.join(project, 'hard-link-to-secret')] });
  });

  it('refuses a project whose path goes through a symbolic link', async () => {
    const { project, base, calls, sharing } = await setup();
    const alias = path.join(base, 'alias');
    await fs.symlink(project, alias);
    await expect(sharing.share(alias)).rejects.toMatchObject({ code: 'share_project_through_link' });
    expect(calls).toEqual([]);
  });

  it('refuses the home folder, anything above it, and the private folders inside it', async () => {
    const { home, calls, sharing } = await setup();
    await fs.mkdir(path.join(home, '.config', 'app'), { recursive: true });
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await expect(sharing.share(home)).rejects.toMatchObject({ code: 'share_project_too_wide' });
    await expect(sharing.share(path.dirname(home))).rejects.toMatchObject({ code: 'share_project_too_wide' });
    await expect(sharing.share(path.join(home, '.config', 'app'))).rejects.toMatchObject({ code: 'share_project_private_folder' });
    await expect(sharing.share(path.join(home, '.ssh'))).rejects.toMatchObject({ code: 'share_project_private_folder' });
    expect(calls).toEqual([]);
  });

  it('refuses a project that holds a file the human\'s shell or programs read through a link in the home folder', async () => {
    const { project, home, calls, sharing } = await setup();
    await fs.mkdir(path.join(project, 'dotfiles'), { recursive: true });
    await fs.writeFile(path.join(project, 'dotfiles', 'zshrc'), 'export PATH');
    await fs.symlink(path.join(project, 'dotfiles', 'zshrc'), path.join(home, '.zshrc'));
    await expect(sharing.share(project)).rejects.toMatchObject({
      code: 'share_project_holds_owner_configuration',
      details: { links: [{ link: path.join(home, '.zshrc'), target: path.join(project, 'dotfiles', 'zshrc') }] },
    });
    expect(calls).toEqual([]);
  });

  it('also finds such links one level down in ~/.config and in ~/.local/bin', async () => {
    const { project, home, sharing } = await setup();
    await fs.mkdir(path.join(home, '.config'), { recursive: true });
    await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await fs.mkdir(path.join(project, 'opencode'), { recursive: true });
    await fs.writeFile(path.join(project, 'tool'), '#!/bin/sh');
    await fs.symlink(path.join(project, 'opencode'), path.join(home, '.config', 'opencode'));
    await fs.symlink(path.join(project, 'tool'), path.join(home, '.local', 'bin', 'tool'));
    const failure = await sharing.share(project).catch((error) => error);
    expect(failure.code).toBe('share_project_holds_owner_configuration');
    expect(failure.details.links.map((entry) => entry.link).sort()).toEqual([path.join(home, '.config', 'opencode'), path.join(home, '.local', 'bin', 'tool')]);
  });

  it('refuses a project on a network filesystem, or with another filesystem mounted inside', async () => {
    const network = await setup();
    const nfs = `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 22 0:50 / ${network.home} rw - nfs4 server:/home rw\n`;
    const remote = createProjectSharingWith(network, nfs);
    await expect(remote.share(network.project)).rejects.toMatchObject({ code: 'share_project_filesystem' });

    const nested = await setup();
    const mounts = `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n41 22 0:51 / ${path.join(nested.project, 'data')} rw - tmpfs tmpfs rw\n`;
    await expect(createProjectSharingWith(nested, mounts).share(nested.project)).rejects.toMatchObject({ code: 'share_project_nested_mount' });
  });

  it('refuses a folder the human does not own', async () => {
    const { project, sharing } = await setup();
    const sharingForOther = createProjectSharingAs(sharing, project, 1);
    await expect(sharingForOther.share(project)).rejects.toMatchObject({ code: 'share_project_not_owned' });
  });

  it('lists what the agent can read by name in the home folders it can now cross', async () => {
    const { project, home, sharing } = await setup();
    await fs.writeFile(path.join(home, '.bashrc'), 'alias ll=ls');
    await fs.chmod(path.join(home, '.bashrc'), 0o644);
    await fs.writeFile(path.join(home, '.zshrc.local'), 'export TOKEN=1');
    await fs.chmod(path.join(home, '.zshrc.local'), 0o600);
    const result = await sharing.share(project);
    expect(result.exposed).toContain(path.join(home, '.bashrc'));
    expect(result.exposed).not.toContain(path.join(home, '.zshrc.local'));
  });

  it('takes the entries back, and keeps the way through a folder another share still needs', async () => {
    const { project, home, calls, sharing } = await setup();
    const second = path.join(home, 'workspace', 'other');
    await fs.mkdir(second, { recursive: true });
    await sharing.share(project);
    await sharing.share(second);
    calls.length = 0;
    expect(await sharing.unshare(project)).toMatchObject({ path: project, status: 'unshared' });
    expect(targetsOf(calls, 'u:dev-agent,d:u:dev-agent')).toContain(project);
    // The home and the workspace still lead to the other project, so they keep their entries.
    expect(targetsOf(calls, 'u:dev-agent').filter((target) => target === home || target === path.join(home, 'workspace'))).toEqual([]);
    expect((await sharing.list()).map((entry) => entry.path)).toEqual([second]);
  });

  it('does not touch a folder that replaced the shared one under the same name', async () => {
    const { project, base, calls, sharing } = await setup();
    await sharing.share(project);
    await fs.rename(project, path.join(base, 'moved-away'));
    await fs.mkdir(project);
    calls.length = 0;
    await sharing.unshare(project);
    expect(targetsOf(calls, 'u:dev-agent,d:u:dev-agent')).toEqual([]);
  });

  it('reports a partial share when setfacl fails, and records it as partial', async () => {
    const { project, base, home } = await setup();
    const sharing = createProjectSharing({
      human: { name: 'dev', uid: process.getuid(), gid: process.getgid(), home },
      agent: { name: 'dev-agent', uid: 2_000_000_002, gid: 2_000_000_002, home: '/home/dev-agent' },
      run: async (_file, args) => ({ code: args.includes(path.join(project, 'README.md')) ? 1 : 0, stdout: '', stderr: 'Operation not permitted' }),
      statePath: path.join(base, 'state', 'shares.json'),
      readMountInfo: async () => '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n',
    });
    const result = await sharing.share(project);
    expect(result.status).toBe('partial');
    expect(result.failed).toContain(path.join(project, 'README.md'));
    expect((await sharing.list())[0].status).toBe('partial');
  });
});

function createProjectSharingWith({ home, base }, mountInfo) {
  return createProjectSharing({
    human: { name: 'dev', uid: process.getuid(), gid: process.getgid(), home },
    agent: { name: 'dev-agent', uid: 2_000_000_002, gid: 2_000_000_002, home: '/home/dev-agent' },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    statePath: path.join(base, 'state', 'shares.json'),
    readMountInfo: async () => mountInfo,
  });
}

function createProjectSharingAs(_sharing, project, uid) {
  return createProjectSharing({
    human: { name: 'someone', uid, gid: uid, home: path.dirname(path.dirname(project)) },
    agent: { name: 'dev-agent', uid: 2_000_000_002, gid: 2_000_000_002, home: '/home/dev-agent' },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    statePath: path.join(path.dirname(project), 'shares.json'),
    readMountInfo: async () => '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n',
  });
}

describe('who owns a project folder', () => {
  it('names the agent for its own folders, the human for theirs, and nothing for a link or a file', async () => {
    const { project, base, sharing, calls } = await setup();
    expect(await sharing.ownerOf(project)).toBe('human');
    await fs.symlink(project, path.join(base, 'alias'));
    expect(await sharing.ownerOf(path.join(base, 'alias'))).toBe('other');
    expect(await sharing.ownerOf(path.join(project, 'README.md'))).toBe('other');
    expect(await sharing.ownerOf('relative/path')).toBe('other');
    const asAgent = createProjectSharing({
      human: { name: 'dev', uid: 2_000_000_001, gid: 2_000_000_001, home: '/home/dev' },
      agent: { name: 'dev-agent', uid: process.getuid(), gid: process.getgid(), home: base },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      statePath: path.join(base, 'state', 'shares.json'),
    });
    expect(await asAgent.ownerOf(project)).toBe('agent');
    // Asking changes nothing.
    expect(calls).toEqual([]);
  });
});
