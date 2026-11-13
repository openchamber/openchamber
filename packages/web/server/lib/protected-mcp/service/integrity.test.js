import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustedFixtureDirectory } from '../test-support/fixtures.js';
import { ProtectedMcpError } from './contract.js';
import { createIntegrity } from './integrity.js';
import { runPreflight } from './preflight.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const engine = { uid: 2_000_000_002, gids: [2_000_000_002] };
const integrity = () => createIntegrity({ owners: [0, process.getuid()], groups: [0], engine, readAcl: async () => [] });
const hasGetfacl = spawnSync('getfacl', ['--version']).status === 0;
// What the real reader does when getfacl runs and fails.
const unreadableAcl = async (target) => {
  throw new ProtectedMcpError('acl_unreadable', { status: 500, message: `acl_unreadable: ${target}` });
};

async function installedTree() {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const tree = path.join(scratch.directory, 'tree');
  await fs.mkdir(path.join(tree, 'lib', 'service'), { recursive: true });
  await fs.writeFile(path.join(tree, 'lib', 'service', 'main.js'), '');
  for (const directory of [tree, path.join(tree, 'lib'), path.join(tree, 'lib', 'service')]) await fs.chmod(directory, 0o755);
  return tree;
}

describe('integrity of installed trees', () => {
  it('finds a writable directory or file below the installed path, which the ancestor check misses', async () => {
    const tree = await installedTree();
    expect((await integrity().inspectTree(tree)).findings).toEqual([]);
    // Write for others only, so each case shows one finding; 0o777 would add the group bit too.
    await fs.chmod(path.join(tree, 'lib', 'service'), 0o757);
    expect((await integrity().inspect(tree)).findings).toEqual([]);
    expect((await integrity().inspectTree(tree)).findings).toEqual([{ code: 'writable_by_others', subject: path.join(tree, 'lib', 'service') }]);
    await fs.chmod(path.join(tree, 'lib', 'service'), 0o755);
    await fs.chmod(path.join(tree, 'lib', 'service', 'main.js'), 0o646);
    expect((await integrity().inspectTree(tree)).findings.map((finding) => finding.code)).toEqual(['writable_by_others']);
  });

  it('makes the preflight report a tampered tree as unprotected', async () => {
    const tree = await installedTree();
    const run = () => runPreflight({ integrity: integrity(), engine, engineUser: 'engine', trustedPaths: [], trustedTrees: [tree], privateDirectories: [], sockets: [], readGroups: async () => '' });
    expect((await run()).status).toBe('protected');
    await fs.chmod(path.join(tree, 'lib'), 0o775);
    expect(await run()).toMatchObject({ status: 'unprotected', findings: [{ code: 'writable_by_group', level: 'error', subject: path.join(tree, 'lib') }] });
  });

  it('follows every link on the way, so a hop through a writable directory is caught', async () => {
    const scratch = await trustedFixtureDirectory();
    cleanups.push(scratch.remove);
    const at = (...parts) => path.join(scratch.directory, ...parts);
    await fs.mkdir(at('bin'));
    await fs.mkdir(at('real'));
    await fs.mkdir(at('alternatives'));
    await fs.writeFile(at('real', 'node'), '', { mode: 0o755 });
    await fs.chmod(at('real', 'node'), 0o755);
    for (const directory of ['bin', 'real', 'alternatives']) await fs.chmod(at(directory), 0o755);
    // bin/node -> alternatives/node -> real/node, like /usr/bin/node through /etc/alternatives.
    await fs.symlink(at('alternatives', 'node'), at('bin', 'node'));
    await fs.symlink(at('real', 'node'), at('alternatives', 'node'));
    expect((await integrity().inspect(at('bin', 'node'))).findings).toEqual([]);
    await fs.chmod(at('alternatives'), 0o757);
    expect((await integrity().inspect(at('bin', 'node'))).findings).toEqual([{ code: 'writable_by_others', subject: at('alternatives') }]);
    await expect(integrity().checkExecutable(at('bin', 'node'))).rejects.toMatchObject({ code: 'untrusted_executable' });
  });

  it('follows links in directory components too, so a directory hop through a writable directory is caught', async () => {
    const scratch = await trustedFixtureDirectory();
    cleanups.push(scratch.remove);
    const at = (...parts) => path.join(scratch.directory, ...parts);
    for (const directory of ['trusted', 'mutable', 'safe', path.join('safe', 'bin')]) {
      await fs.mkdir(at(directory));
      await fs.chmod(at(directory), 0o755);
    }
    await fs.writeFile(at('safe', 'bin', 'node'), '');
    await fs.chmod(at('safe', 'bin', 'node'), 0o755);
    // trusted/bin -> mutable/hop -> safe/bin: the links are directories of the path, not its last part.
    await fs.symlink(at('mutable', 'hop'), at('trusted', 'bin'));
    await fs.symlink('../safe/bin', at('mutable', 'hop'));
    expect((await integrity().inspect(at('trusted', 'bin', 'node'))).findings).toEqual([]);
    await fs.chmod(at('mutable'), 0o757);
    expect((await integrity().inspect(at('trusted', 'bin', 'node'))).findings).toEqual([{ code: 'writable_by_others', subject: at('mutable') }]);
    await expect(integrity().checkExecutable(at('trusted', 'bin', 'node'))).rejects.toMatchObject({ code: 'untrusted_executable' });
  });

  it('lets a missing argument pass only where the engine could not create it, and refuses one it cannot inspect', async () => {
    const scratch = await trustedFixtureDirectory();
    const at = (...parts) => path.join(scratch.directory, ...parts);
    cleanups.push(async () => {
      await fs.chmod(at('closed'), 0o755).catch(() => {});
      await scratch.remove();
    });
    for (const directory of ['safe', 'open', 'closed']) {
      await fs.mkdir(at(directory));
      await fs.chmod(at(directory), 0o755);
    }
    await fs.chmod(at('open'), 0o757);
    // Nobody else can write where it would be created, so nobody else can create it.
    await expect(integrity().checkArgument(at('safe', 'script.js'))).resolves.toBeUndefined();
    await expect(integrity().checkArgument(at('safe', 'missing', 'script.js'))).resolves.toBeUndefined();
    // Others can write there: the engine could create it between the check and the start.
    await expect(integrity().checkArgument(at('open', 'script.js'))).rejects.toMatchObject({ code: 'untrusted_argument' });
    await expect(integrity().checkArgument(at('open', 'missing', 'script.js'))).rejects.toMatchObject({ code: 'untrusted_argument' });
    // Behind a directory the service cannot search, nothing can be judged.
    await fs.chmod(at('closed'), 0o000);
    await expect(integrity().checkArgument(at('closed', 'script.js'))).rejects.toMatchObject({ code: 'untrusted_argument' });
  });

  it('counts a root-equivalent socket an ACL opens to the engine, and one it cannot inspect as unverified', async () => {
    // A Unix socket path must stay under 108 bytes, so these live in /tmp.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-acl-'));
    cleanups.push(async () => {
      await fs.chmod(path.join(root, 'closed'), 0o700).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
    const socketPath = path.join(root, 'docker.sock');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    // Only its owner may connect by mode bits.
    await fs.chmod(socketPath, 0o600);
    const run = (readAcl, sockets = [socketPath]) => runPreflight({
      integrity: createIntegrity({ owners: [0, process.getuid()], groups: [0], engine, readAcl }),
      engine, engineUser: 'engine', trustedPaths: [], privateDirectories: [], sockets, socketOwners: [process.getuid()], readGroups: async () => '',
    });
    expect(await run(async () => [])).toMatchObject({ status: 'protected', findings: [] });
    expect(await run(async () => [`user:${engine.uid}:rw-`])).toMatchObject({
      status: 'unprotected', findings: [{ code: 'root_equivalent_socket', level: 'error', subject: socketPath }],
    });
    expect(await run(async () => null)).toMatchObject({
      status: 'unverified', findings: [{ code: 'acl_not_inspected', level: 'unknown', subject: socketPath }],
    });
    // An ACL that could not be read is unknown, not a confirmed opening.
    expect(await run(unreadableAcl)).toMatchObject({
      status: 'unverified', findings: [{ code: 'acl_unreadable', level: 'unknown', subject: socketPath }],
    });
    // A socket behind a directory the service cannot search is not taken as absent.
    await fs.mkdir(path.join(root, 'closed'));
    const hidden = path.join(root, 'closed', 'containerd.sock');
    await fs.chmod(path.join(root, 'closed'), 0o000);
    expect(await run(async () => [], [hidden])).toMatchObject({
      status: 'unverified', findings: [{ code: 'socket_not_inspected', level: 'unknown', subject: hidden }],
    });
    expect(await run(async () => [], [path.join(root, 'absent.sock')])).toMatchObject({ status: 'protected', findings: [] });
  });

  it.skipIf(!hasGetfacl)('reads a failed getfacl as unreadable, never as a writer', async () => {
    const real = createIntegrity({ owners: [0, process.getuid()], groups: [0], engine });
    await expect(real.aclWriters(path.join(os.tmpdir(), `pmcp-missing-${process.pid}`))).rejects.toMatchObject({ code: 'acl_unreadable' });
  });

  it('takes an ACL it cannot read as unknown: the status is unverified and what sits there does not run', async () => {
    const scratch = await trustedFixtureDirectory();
    cleanups.push(scratch.remove);
    const file = path.join(scratch.directory, 'node');
    await fs.writeFile(file, '');
    await fs.chmod(file, 0o755);
    const failing = createIntegrity({ owners: [0, process.getuid()], groups: [0], engine, readAcl: unreadableAcl });
    expect((await failing.inspect(file)).findings).toContainEqual({ code: 'acl_unreadable', subject: file });
    await expect(failing.checkExecutable(file)).rejects.toMatchObject({ code: 'untrusted_executable' });
    const result = await runPreflight({ integrity: failing, engine, engineUser: 'engine', trustedPaths: [file], privateDirectories: [], sockets: [], readGroups: async () => '' });
    expect(result.status).toBe('unverified');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((finding) => finding.code === 'acl_unreadable' && finding.level === 'unknown')).toBe(true);
  });

  it('reports a missing ACL tool as not inspected rather than clean', async () => {
    const tree = await installedTree();
    const noAcl = createIntegrity({ owners: [0, process.getuid()], groups: [0], engine, readAcl: async () => null });
    const result = await runPreflight({ integrity: noAcl, engine, engineUser: 'engine', trustedPaths: [], trustedTrees: [tree], privateDirectories: [], sockets: [], readGroups: async () => '' });
    expect(result.status).toBe('unverified');
    expect(result.findings).toEqual([{ code: 'acl_not_inspected', level: 'unknown', subject: tree }]);
  });
});
