import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveBunExecutable } from '../../../../../scripts/lib/bun-executable.mjs';

import { cloneGitRepository, parseGitInstallUrl, prepareGuestGitNetwork } from './clone.js';
import { installGuestFromGitSource, parseInstallRequest } from './install.js';
import { listInstalledGuests } from './catalog.js';
import { readExtensionStore } from './persist.js';
import { checkGuestUpdate, updateGuest } from './updates.js';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const source = 'git@github.com:acme/fixture.git';
const testPath = fileURLToPath(import.meta.url);
const bunExecutable = resolveBunExecutable();
const savedEnv = new Map();
let root;
let repo;
let profilesPath;
let logPath;
let globalKey;
let workKey;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  cwd: root,
  env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  stdio: 'pipe',
});
const setEnv = (key, value) => {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
const writeProfiles = (key) => fs.writeFile(profilesPath, JSON.stringify({ profiles: key ? [{ id: 'work', name: 'Work', userName: 'Fixture', userEmail: 'fixture@example.com', sshKey: key }] : [] }));
const publishVersion = async (version) => {
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version,
    openchamber: { apiVersion: 1, contributes: { panel: { id: 'ssh-fixture', name: 'Fixture', icon: 'window', entry: 'panel/index.html' } } } }));
  git('add', '.');
  git('commit', '-m', `fixture ${version}`);
};
const sshCalls = async () => (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

if (!process.env.GUEST_SSH_TEST_HOME) {
  test('SSH integration suite uses an isolated server home', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'guest-ssh-test-'));
    const protectedPaths = [path.join(os.homedir(), '.gitconfig'), path.resolve(path.dirname(testPath), '../../../../../.git/config')];
    const readProtected = async (file) => {
      try { return await fs.readFile(file); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    };
    const before = await Promise.all(protectedPaths.map(readProtected));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(home),
      GUEST_SSH_TEST_HOME: home,
    });
    try {
      const refused = spawnSync(bunExecutable, ['test', testPath], {
        env, cwd: path.dirname(home), stdio: 'pipe', timeout: 60_000,
      });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr.toString()).toContain('SSH fixture refused to run without an isolated home');
      // Bun's default child-process environment can ignore late process.env
      // edits. Establish isolation at process startup and always pass env/cwd.
      execFileSync(bunExecutable, ['test', testPath], {
        env, cwd: home, stdio: 'pipe', timeout: 60_000,
      });
    } finally {
      const after = await Promise.all(protectedPaths.map(readProtected));
      await fs.rm(home, { recursive: true, force: true });
      // Compare bytes without printing configuration contents on a failure.
      for (let index = 0; index < before.length; index++) {
        const unchanged = before[index] === null ? after[index] === null : after[index] !== null && before[index].equals(after[index]);
        expect(unchanged).toBe(true);
      }
    }
  });
} else {
beforeAll(async () => {
  root = process.env.GUEST_SSH_TEST_HOME;
  const realRoot = await fs.realpath(root);
  if (path.dirname(realRoot) !== await fs.realpath(os.tmpdir())
    || !path.basename(realRoot).startsWith('guest-ssh-test-')
    || await fs.realpath(os.homedir()) !== realRoot
    || await fs.realpath(process.cwd()) !== realRoot
    || process.env.GIT_CONFIG_GLOBAL !== path.join(root, '.gitconfig')) {
    throw new Error('SSH fixture refused to run without an isolated home, cwd, and Git config');
  }
  repo = path.join(root, 'repository');
  const bin = path.join(root, 'bin');
  profilesPath = path.join(root, '.config/openchamber/git-identities.json');
  logPath = path.join(root, 'ssh-calls.jsonl');
  globalKey = path.join(root, 'global key');
  workKey = path.join(root, 'work key');
  await fs.mkdir(path.dirname(profilesPath), { recursive: true });
  await fs.mkdir(bin);
  await fs.mkdir(path.join(repo, 'panel'), { recursive: true });
  setEnv('HOME', root);
  setEnv('GIT_CONFIG_GLOBAL', path.join(root, '.gitconfig'));
  setEnv('GIT_CONFIG_NOSYSTEM', '1');
  setEnv('GIT_SSH_COMMAND', undefined);
  setEnv('GIT_SSH', undefined);
  setEnv('SSH_AUTH_SOCK', path.join(root, 'fixture-agent.sock'));
  setEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv('GUEST_TEST_REPO', repo);
  setEnv('GUEST_TEST_SSH_LOG', logPath);
  // Real Git protocol over a local test transport: no server key or network is used.
  await fs.writeFile(path.join(bin, 'ssh'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nappendFileSync(process.env.GUEST_TEST_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), agent: process.env.SSH_AUTH_SOCK }) + '\\n');\nconst result = spawnSync('git', ['upload-pack', process.env.GUEST_TEST_REPO], { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
  // Seed only this explicit fixture file. Never run `git config --global` here.
  await fs.writeFile(path.join(root, '.gitconfig'), `[user]\n  name = Fixture\n  email = fixture@example.com\n[core]\n  sshCommand = ${JSON.stringify(`ssh -i '${globalKey}'`)}\n`);
  git('init', '--initial-branch=main');
  await fs.writeFile(path.join(repo, 'panel/index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(repo, 'panel/main.js'), 'console.log("fixture");');
  await writeProfiles(workKey);
  await publishVersion('1.0.0');
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('SSH extension installs', () => {
  test('accepts SSH and scp URLs with refs, but rejects credentials, private targets and shell syntax', () => {
    expect(parseGitInstallUrl(`${source}#main`)).toEqual({ url: source, ref: 'main' });
    expect(parseGitInstallUrl('ssh://git@github.com:2222/acme/fixture.git')).toEqual({ url: 'ssh://git@github.com:2222/acme/fixture.git' });
    expect(parseGitInstallUrl('SSH://git@github.com/acme/fixture.git')).toEqual({ url: 'ssh://git@github.com/acme/fixture.git' });
    for (const url of ['ssh://git:password@github.com/acme/repo', 'ssh://git@127.0.0.1/repo', 'git@localhost:repo', 'ssh://git@github.com:99999/repo', 'git@github.com:repo;id', 'ssh://git@github.com/repo?command=id', 'ssh://git@bad\'host.com/repo', `${source}\n`]) {
      expect(parseGitInstallUrl(url)).toBeNull();
    }
    expect(parseInstallRequest({ url: source, gitIdentityId: 'work' })).toEqual({ url: source, gitIdentityId: 'work' });
    expect(parseInstallRequest({ url: source, gitIdentityId: {} })).toBeNull();
  });

  test('global identity uses host SSH configuration and inherits its agent', async () => {
    expect(await cloneGitRepository(source, path.join(root, 'global-clone'), { lookup })).toEqual({ ok: true });
    const call = (await sshCalls()).at(-1);
    expect(call.args).toContain(globalKey);
    expect(call.agent).toBe(process.env.SSH_AUTH_SOCK);
    expect(call.args).toContain('BatchMode=yes');
    expect(call.args).toContain('Hostname=93.184.216.34');
    expect(call.args).toContain('HostKeyAlias=github.com');
    expect(await cloneGitRepository('ssh://git@github.com:2222/acme/fixture.git', path.join(root, 'port-clone'), { lookup })).toEqual({ ok: true });
    expect((await sshCalls()).at(-1).args).toContain('2222');
  });

  test('rejects DNS answers into private networks', async () => {
    expect(await prepareGuestGitNetwork(source, { lookup: async () => [{ address: '10.0.0.1', family: 4 }] })).toBeNull();
  });

  test('persists the selected identity and re-resolves it for update checks and replacement clones', async () => {
    const persistPath = path.join(root, 'extensions.json');
    const result = await installGuestFromGitSource(source, persistPath, { gitIdentityId: 'work', ref: 'main', lookup });
    expect(result.ok).toBe(true);
    const [guest] = await listInstalledGuests({ persistPath });
    expect(guest.gitOrigin).toEqual({ url: source, ref: 'main', gitIdentityId: 'work' });
    expect((await sshCalls()).at(-1).args).toContain(workKey);
    expect(JSON.stringify(await readExtensionStore(persistPath))).not.toContain(workKey);

    const rotatedKey = path.join(root, 'rotated key');
    await writeProfiles(rotatedKey);
    await publishVersion('1.1.0');
    expect(await checkGuestUpdate({ guest, origin: guest.gitOrigin, lookup })).toMatchObject({ available: true, version: '1.1.0' });
    expect((await sshCalls()).at(-1).args).toContain(rotatedKey);
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, lookup })).toMatchObject({ ok: true });
    expect((await sshCalls()).at(-1).args).toContain(rotatedKey);

    await writeProfiles(null);
    expect(await checkGuestUpdate({ guest, origin: guest.gitOrigin, lookup })).toMatchObject({ available: false, error: 'fetch-failed' });
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, lookup })).toMatchObject({ ok: false, code: 'clone-failed' });
    const [preserved] = await listInstalledGuests({ persistPath });
    expect(preserved.version).toBe('1.1.0');
  });
});
}
