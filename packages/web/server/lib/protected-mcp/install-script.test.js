import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { trustedFixtureDirectory } from './test-support/fixtures.js';

const script = fileURLToPath(new URL('../../../../../scripts/install.sh', import.meta.url));
// Root and the test user own the repository's scratch folder and its parents.
const owners = `0 ${process.getuid()}`;
const hasSetfacl = spawnSync('setfacl', ['--version']).status === 0;

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Runs the script's own check, loaded without running the installer. */
const trusted = (target, list = owners) => new Promise((resolve) => {
  execFile('bash', ['-c', '. "$1"; protected_mcp_trusted_path "$2" $3', 'check', script, target, list], {
    env: { PATH: process.env.PATH, OPENCHAMBER_INSTALL_FUNCTIONS_ONLY: '1' },
    timeout: 10_000,
  }, (error) => resolve(!error));
});

async function scratch() {
  const { directory, remove } = await trustedFixtureDirectory();
  cleanups.push(remove);
  const at = (...parts) => path.join(directory, ...parts);
  const executable = async (file, mode = 0o755) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.chmod(path.dirname(file), 0o755);
    await fs.writeFile(file, '');
    await fs.chmod(file, mode);
    return file;
  };
  return { at, executable };
}

describe('install.sh checks what root is about to run', () => {
  it('inherits stdin when invoking the protected installer', () => {
    // Given
    const env = { PATH: process.env.PATH, OPENCHAMBER_INSTALL_FUNCTIONS_ONLY: '1' };
    // When
    const result = spawnSync('bash', ['-c', '. "$1"; declare -f protected_mcp_install', 'check', script], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('service/install.js');
    expect(result.stdout).not.toMatch(/tty_input|\/dev\/(tty|stdin)|<\s*["$]/);
  });

  it('trusts a file whose whole path only its owners can change', async () => {
    const { at, executable } = await scratch();
    const node = await executable(at('bin', 'node'));
    expect(await trusted(node)).toBe(true);
    // The same file is not trusted when only root may own it: the test user does.
    expect(await trusted(node, '0')).toBe(false);
  });

  it('refuses a file others or its group can write', async () => {
    const { at, executable } = await scratch();
    expect(await trusted(await executable(at('a', 'node'), 0o757))).toBe(false);
    expect(await trusted(await executable(at('b', 'node'), 0o775))).toBe(false);
  });

  it('refuses a file under a directory others can write', async () => {
    const { at, executable } = await scratch();
    const node = await executable(at('open', 'node'));
    await fs.chmod(at('open'), 0o757);
    expect(await trusted(node)).toBe(false);
  });

  it.skipIf(!hasSetfacl)('refuses a file an ACL lets someone else write, and accepts a read-only entry', async () => {
    const { at, executable } = await scratch();
    const node = await executable(at('acl', 'node'));
    // A named entry for another account; the test's own uid is the one this sandbox maps.
    expect(spawnSync('setfacl', ['-m', `u:${process.getuid()}:r`, node]).status).toBe(0);
    expect(await trusted(node)).toBe(true);
    expect(spawnSync('setfacl', ['-m', `u:${process.getuid()}:rw`, node]).status).toBe(0);
    expect(await trusted(node)).toBe(false);
  });

  it('follows each link and refuses a hop through a writable directory', async () => {
    const { at, executable } = await scratch();
    const real = await executable(at('real', 'node'));
    await fs.mkdir(at('bin'));
    await fs.mkdir(at('alternatives'));
    await fs.chmod(at('bin'), 0o755);
    await fs.chmod(at('alternatives'), 0o755);
    await fs.symlink(at('alternatives', 'node'), at('bin', 'node'));
    await fs.symlink(path.relative(at('alternatives'), real), at('alternatives', 'node'));
    expect(await trusted(at('bin', 'node'))).toBe(true);
    await fs.chmod(at('alternatives'), 0o757);
    expect(await trusted(at('bin', 'node'))).toBe(false);
  });

  it('follows links in directory components too, and refuses a directory hop through a writable directory', async () => {
    const { at, executable } = await scratch();
    await executable(at('safe', 'bin', 'node'));
    for (const directory of ['trusted', 'mutable']) {
      await fs.mkdir(at(directory));
      await fs.chmod(at(directory), 0o755);
    }
    // trusted/bin -> mutable/hop -> safe/bin: the links are directories of the path, not its last part.
    await fs.symlink(at('mutable', 'hop'), at('trusted', 'bin'));
    await fs.symlink('../safe/bin', at('mutable', 'hop'));
    expect(await trusted(at('trusted', 'bin', 'node'))).toBe(true);
    await fs.chmod(at('mutable'), 0o757);
    expect(await trusted(at('trusted', 'bin', 'node'))).toBe(false);
  });

  it('removes the work directory when the script exits after the function that made it returned', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-workdir-'));
    cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
    // Like protected_mcp_install: a local directory, the cleanup registered, the function returns.
    const outcome = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      '. "$1"',
      'make() { local workdir; workdir=$(mktemp -d "$2/work.XXXXXX"); protected_mcp_remove_on_exit "$workdir"; }',
      'make "$@"',
      'echo returned',
    ].join('\n'), 'check', script, base], { env: { PATH: process.env.PATH, OPENCHAMBER_INSTALL_FUNCTIONS_ONLY: '1' }, encoding: 'utf8', timeout: 10_000 });
    expect(outcome.stdout).toContain('returned');
    expect(outcome.status).toBe(0);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it('refuses a missing path and a link loop', async () => {
    const { at } = await scratch();
    expect(await trusted(at('missing'))).toBe(false);
    await fs.symlink(at('loop-b'), at('loop-a'));
    await fs.symlink(at('loop-a'), at('loop-b'));
    expect(await trusted(at('loop-a'))).toBe(false);
  });
});
