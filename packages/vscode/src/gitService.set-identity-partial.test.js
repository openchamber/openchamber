import { beforeEach, describe, expect, it, mock } from 'bun:test';

// No Git extension is available, so setGitIdentity takes its raw-git fallback.
mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const execGit = mock(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
mock.module('./bridge-git-process-runtime', () => ({ execGit }));

const { setGitIdentity } = await import('./gitService.ts?set-identity-partial-test');

const writtenConfig = () => execGit.mock.calls.map(([args]) => args.slice(1).join(' '));

beforeEach(() => {
  execGit.mockReset();
  execGit.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
});

describe('VS Code git service setGitIdentity partial failure (#668)', () => {
  it('stops at the first failing write and reports the git error', async () => {
    execGit.mockImplementation(async (args) => (
      args[1] === 'user.signingkey'
        ? { stdout: '', stderr: 'error: could not lock config file .git/config: File exists\n', exitCode: 255 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await expect(setGitIdentity('/repo', 'Alice', 'alice@example.com', null, true, 'KEY'))
      .rejects.toThrow('could not lock config file .git/config: File exists');

    expect(writtenConfig()).toEqual([
      'user.name Alice',
      'user.email alice@example.com',
      'gpg.format ssh',
      'user.signingkey KEY',
    ]);
  });

  it('writes the same keys in the same order when every write succeeds', async () => {
    await expect(setGitIdentity('/repo', 'Alice', 'alice@example.com', '/home/alice/.ssh/id_ed25519', true, 'KEY'))
      .resolves.toEqual({ success: true });

    expect(writtenConfig()).toEqual([
      'user.name Alice',
      'user.email alice@example.com',
      "core.sshCommand ssh -i '/home/alice/.ssh/id_ed25519' -o IdentitiesOnly=yes",
      'gpg.format ssh',
      'user.signingkey KEY',
      'commit.gpgsign true',
    ]);
  });
});
