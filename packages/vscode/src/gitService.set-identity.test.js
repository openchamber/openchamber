import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No Git extension is available, so setGitIdentity takes its raw-git fallback.
mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { setGitIdentity } = await import('./gitService.ts?set-identity-test');

const tempDirs = [];

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-set-identity-'));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  return dir;
};

const readLocalConfig = (cwd) => {
  const output = runGit(cwd, ['config', '--local', '--list']);
  return Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service setGitIdentity raw-git fallback (#668)', () => {
  it('writes the author, SSH and signing configuration and reports success', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    const sshKey = path.join(dir, 'id_ed25519');

    const result = await setGitIdentity(dir, 'Alice', 'alice@example.com', sshKey, true, 'ssh-ed25519 AAAA');

    expect(result).toEqual({ success: true });
    expect(readLocalConfig(dir)).toMatchObject({
      'user.name': 'Alice',
      'user.email': 'alice@example.com',
      'core.sshcommand': `ssh -i '${sshKey}' -o IdentitiesOnly=yes`,
      'gpg.format': 'ssh',
      'user.signingkey': 'ssh-ed25519 AAAA',
      'commit.gpgsign': 'true',
    });
  });

  it('reports failure for a directory that is not a git repository and writes nothing', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(setGitIdentity(dir, 'Alice', 'alice@example.com')).rejects.toThrow(/not in a git directory/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports failure when a config write cannot lock the repository config', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    const lockPath = path.join(dir, '.git', 'config.lock');
    fs.writeFileSync(lockPath, '');

    await expect(setGitIdentity(dir, 'Alice', 'alice@example.com')).rejects.toThrow(/could not lock config file/);

    fs.rmSync(lockPath);
    expect(readLocalConfig(dir)['user.name']).toBeUndefined();
  });
});
