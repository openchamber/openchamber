import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { grantRetainedBotAccess } from './bot-migration-access.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const perms = (value) => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
const aclPermission = (acl, type, id = '', defaults = false) => acl.split('\n').find((line) => line.startsWith(`${defaults ? 'default:' : ''}${type}:${id}:`))?.split(':').at(-1);
const identity = async (directory) => { const stat = await fs.stat(directory, { bigint: true }); return `${stat.dev}:${stat.ino}`; };

async function fixture() {
  const base = await fs.mkdtemp('/tmp/opencode/bot-access-'); roots.push(base);
  const root = path.join(base, 'root');
  const human = { name: 'human', uid: process.getuid(), gid: process.getgid(), home: '/home/human' };
  const agent = { name: 'agent', uid: 2_000_000_002, gid: 2_000_000_002, gids: [2_000_000_002] };
  const at = (directory) => path.join(root, directory);
  const directory = '/home/human/.config/openchamber/bot-worktrees/owned';
  const gitDirectory = '/home/human/project/.git/worktrees/owned';
  await fs.mkdir(at(`${directory}/src`), { recursive: true });
  await fs.mkdir(at(gitDirectory), { recursive: true });
  for (const name of ['/home/human', '/home/human/.config', '/home/human/.config/openchamber', '/home/human/.config/openchamber/bot-worktrees',
    directory, `${directory}/src`, '/home/human/project', '/home/human/project/.git', '/home/human/project/.git/worktrees', gitDirectory]) await fs.chmod(at(name), 0o700);
  await fs.writeFile(at(`${directory}/src/code.js`), 'retained code', { mode: 0o600 });
  await fs.writeFile(at(`${directory}/.git`), `gitdir: ${gitDirectory}\n`, { mode: 0o600 });
  await fs.writeFile(at(`${gitDirectory}/HEAD`), 'ref: refs/heads/bot/item\n', { mode: 0o600 });
  await fs.writeFile(at('/home/human/.config/openchamber/github-auth.json'), 'private original data', { mode: 0o600 });
  const entry = { projectId: 'p', itemId: 'item', directory, directoryIdentity: await identity(at(directory)), gitDirectory, gitIdentity: await identity(at(gitDirectory)) };
  const acls = new Map();
  const calls = [];
  let beforeWrite = null;
  const run = async (command, args) => {
    if (command.endsWith('/setfacl') && beforeWrite) { const work = beforeWrite; beforeWrite = null; await work(); }
    const target = await fs.realpath(args.at(-1));
    calls.push({ command, args, target });
    if (command.endsWith('/getfacl')) {
      const stat = await fs.stat(target);
      return { code: 0, stdout: acls.get(target) ?? `user::${perms(stat.mode >> 6)}\ngroup::${perms(stat.mode >> 3)}\nother::${perms(stat.mode)}\n`, stderr: '' };
    }
    acls.set(target, args.find((arg) => arg.startsWith('--set=')).slice(6).split(',').map((line) => line.replace(/^d:/, 'default:')).join('\n'));
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { root, botRoot: '/home/human/.config/openchamber/bot-worktrees', entries: [entry], human, agent, run,
    readMountInfo: async () => '1 0 0:1 / / rw - ext4 /dev/fixture rw\n' };
  return { base, root, at, entry, agent, human, acls, calls, options, beforeWrite: (work) => { beforeWrite = work; } };
}

it('grants the exact checkout and Git metadata trees and traverse-only ancestors without changing paths, inodes or bytes', async () => {
  const f = await fixture();
  await fs.symlink(f.at('/home/human/.config/openchamber/github-auth.json'), f.at(`${f.entry.directory}/secret-link`));
  const result = await grantRetainedBotAccess(f.options);
  expect(result.status).toBe('granted');
  const writes = f.calls.filter((call) => call.command.endsWith('/setfacl'));
  expect(writes.length).toBeGreaterThan(0);
  for (const call of writes) expect(call.args.at(-1)).toMatch(new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`));
  for (const directory of [f.entry.directory, `${f.entry.directory}/src`, f.entry.gitDirectory]) {
    const acl = f.acls.get(f.at(directory));
    expect(aclPermission(acl, 'user', String(f.agent.uid))).toBe('rwx');
    expect(aclPermission(acl, 'user', String(f.agent.uid), true)).toBe('rwx');
    expect(aclPermission(acl, 'user', String(f.human.uid), true)).toBe('rwx');
  }
  for (const directory of ['/home/human', '/home/human/.config', '/home/human/.config/openchamber', f.options.botRoot,
    '/home/human/project', '/home/human/project/.git', '/home/human/project/.git/worktrees']) {
    const acl = f.acls.get(f.at(directory));
    expect(aclPermission(acl, 'user', String(f.agent.uid))).toBe('--x');
    expect(acl).not.toContain('default:');
  }
  expect(aclPermission(f.acls.get(f.at(`${f.entry.directory}/src/code.js`)), 'user', String(f.agent.uid))).toBe('rw-');
  expect(writes.some((call) => call.target.includes('github-auth.json') || call.target.includes('secret-link'))).toBe(false);
  expect(await fs.readFile(f.at(`${f.entry.directory}/src/code.js`), 'utf8')).toBe('retained code');
  expect(await identity(f.at(f.entry.directory))).toBe(f.entry.directoryIdentity);
  expect(await identity(f.at(f.entry.gitDirectory))).toBe(f.entry.gitIdentity);
});

it('preserves other principals effective rights when widening restrictive access and default masks', async () => {
  const f = await fixture();
  f.acls.set(f.at('/home/human'), 'user::rwx\nuser:777:rwx\ngroup::rwx\nmask::---\nother::---\n');
  f.acls.set(f.at(f.entry.directory), 'user::rwx\ngroup::rwx\nmask::---\nother::---\ndefault:user::rwx\ndefault:user:777:rwx\ndefault:group::rwx\ndefault:mask::r--\ndefault:other::---\n');
  await grantRetainedBotAccess(f.options);
  const home = f.acls.get(f.at('/home/human'));
  expect(aclPermission(home, 'user', '777')).toBe('---');
  expect(aclPermission(home, 'group')).toBe('---');
  expect(aclPermission(home, 'mask')).toBe('--x');
  const checkout = f.acls.get(f.at(f.entry.directory));
  expect(aclPermission(checkout, 'group')).toBe('---');
  expect(aclPermission(checkout, 'group', '', true)).toBe('r--');
  expect(aclPermission(checkout, 'user', '777', true)).toBe('r--');
  expect(aclPermission(checkout, 'other')).toBe('---');
});

it('new inode owners retain usable creator permissions under an existing restrictive default owner entry', async () => {
  const f = await fixture();
  f.acls.set(f.at(f.entry.directory), 'user::rwx\ngroup::---\nother::---\ndefault:user::---\ndefault:group::---\ndefault:other::---\n');
  await grantRetainedBotAccess(f.options);
  expect(aclPermission(f.acls.get(f.at(f.entry.directory)), 'user', '', true)).toBe('rwx');
  expect(aclPermission(f.acls.get(f.at(f.entry.directory)), 'other', '', true)).toBe('---');
});

it('dry-run inspects the full grant without writing any ACL', async () => {
  const f = await fixture();
  expect(await grantRetainedBotAccess({ ...f.options, dryRun: true })).toMatchObject({ status: 'planned', changed: [] });
  expect(f.calls.some((call) => call.command.endsWith('/getfacl'))).toBe(true);
  expect(f.calls.some((call) => call.command.endsWith('/setfacl'))).toBe(false);
  expect(f.acls.size).toBe(0);
});

it.each(['home', 'data-root', 'alias', 'hardlink', 'nested-mount', 'network-filesystem', 'foreign-inode', 'malformed-acl'])('refuses %s before any grant', async (kind) => {
  const f = await fixture();
  const options = { ...f.options, entries: [{ ...f.entry }] };
  if (kind === 'home') options.entries[0].gitDirectory = '/home/human';
  if (kind === 'data-root') options.entries[0].gitDirectory = '/home/human/.config';
  if (kind === 'foreign-inode') options.entries[0].gitIdentity = '1:1';
  if (kind === 'alias') {
    await fs.symlink(f.at(f.entry.directory), f.at(`${f.options.botRoot}/alias`));
    options.entries[0].directory = `${f.options.botRoot}/alias`;
  }
  if (kind === 'hardlink') await fs.link(f.at('/home/human/.config/openchamber/github-auth.json'), f.at(`${f.entry.directory}/hard-link`));
  if (kind === 'nested-mount') options.readMountInfo = async () => `1 0 0:1 / / rw - ext4 /dev/fixture rw\n2 1 0:2 / ${f.at(`${f.entry.directory}/src`)} rw - tmpfs tmpfs rw\n`;
  if (kind === 'network-filesystem') options.readMountInfo = async () => '1 0 0:1 / / rw - nfs4 server:/home rw\n';
  if (kind === 'malformed-acl') f.acls.set(f.at(f.entry.directory), 'not an ACL');
  await expect(grantRetainedBotAccess(options)).rejects.toThrow();
  expect(f.calls.filter((call) => call.command.endsWith('/setfacl'))).toEqual([]);
});

it('a replacement path cannot redirect a root-held ACL operation outside the trusted inode', async () => {
  const f = await fixture();
  const outside = f.at('/unrelated');
  await fs.mkdir(outside);
  f.beforeWrite(async () => {
    await fs.rename(f.at(f.entry.directory), f.at(`${f.entry.directory}.retained`));
    await fs.symlink(outside, f.at(f.entry.directory));
  });
  await expect(grantRetainedBotAccess(f.options)).rejects.toThrow();
  const writes = f.calls.filter((call) => call.command.endsWith('/setfacl'));
  expect(writes).toHaveLength(1);
  expect(writes[0].target).toBe(f.at(`${f.entry.directory}.retained`));
  expect(f.acls.has(outside)).toBe(false);
  expect(await identity(f.at(`${f.entry.directory}.retained`))).toBe(f.entry.directoryIdentity);
});

it('an ACL operation failure reports partial grants and refuses completion', async () => {
  const f = await fixture();
  const run = async (command, args) => command.endsWith('/setfacl') ? { code: 1, stdout: '', stderr: 'refused' } : f.options.run(command, args);
  await expect(grantRetainedBotAccess({ ...f.options, run })).rejects.toMatchObject({ code: 'migration_bots_access_refused', botAccess: { status: 'partial' } });
});

it('a permission change during planning refuses the grant without overwriting the new ACL', async () => {
  const f = await fixture();
  let reads = 0;
  const changed = 'user::r-x\ngroup::---\nother::---\n';
  const run = async (command, args) => {
    if (command.endsWith('/getfacl') && await fs.realpath(args.at(-1)) === f.at(f.entry.directory) && ++reads === 2) {
      f.acls.set(f.at(f.entry.directory), changed);
    }
    return f.options.run(command, args);
  };
  await expect(grantRetainedBotAccess({ ...f.options, run })).rejects.toMatchObject({ code: 'migration_bots_access_refused' });
  expect(f.calls.filter((call) => call.command.endsWith('/setfacl'))).toEqual([]);
  expect(f.acls.get(f.at(f.entry.directory))).toBe(changed);
});
