import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const executeGit = mock(async (args) => {
  if (args.join('\0') === 'rev-parse\0--git-path\0CHERRY_PICK_HEAD') {
    return { stdout: '.git/worktrees/linked/CHERRY_PICK_HEAD\n', stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: '', exitCode: 1 };
});

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));
mock.module('./bridge-git-process-runtime', () => ({ execGit: executeGit }));

const {
  cherryPick,
  classifyGitOperationFailure,
  getGitRangeDiff,
  getGitRangeFiles,
  merge,
  parseUnmergedFiles,
  rebase,
  resetToCommit,
  resolveGitStateMarker,
  revertCommit,
} = await import('./gitService.ts?operations-test');

const temporaryDirectories = [];

afterEach(async () => {
  executeGit.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('VS Code git operation helpers', () => {
  it('finds a marker at the git-reported linked-worktree path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-git-marker-'));
    temporaryDirectories.push(directory);
    const markerPath = path.join(directory, '.git', 'worktrees', 'linked', 'CHERRY_PICK_HEAD');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, 'a'.repeat(40));

    await expect(resolveGitStateMarker(directory, 'CHERRY_PICK_HEAD')).resolves.toBe(true);
  });

  it('includes every porcelain unmerged status without corrupting NUL-delimited paths', () => {
    expect(parseUnmergedFiles('UU café [a].ts\0AA b\0DD c\0DU d\0UD e\0AU f\0UA g\0R  renamed\0original\0M  h\0')).toEqual([
      'café [a].ts', 'b', 'c', 'd', 'e', 'f', 'g',
    ]);
  });

  it('uses marker and unmerged state when localized output lacks conflict text', () => {
    expect(classifyGitOperationFailure({
      hasMarker: true,
      conflictFiles: ['conflicted.ts'],
    })).toEqual({ success: false, conflict: true, conflictFiles: ['conflicted.ts'] });
  });

  it('prefixes the dirty hard-reset service error', async () => {
    executeGit.mockImplementation(async (args) => (
      args.join('\0') === 'status\0--porcelain'
        ? { stdout: ' M dirty.ts\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 }
    ));

    await expect(resetToCommit('/repo', 'a'.repeat(40), 'hard')).rejects.toThrow(/^\[reset_hard_dirty\]/);
  });

  it('passes an unqualified range base literally when origin has a matching ref', async () => {
    executeGit.mockImplementation(async (args) => (
      args.join('\0') === 'rev-parse\0--verify\0refs/remotes/origin/main'
        ? { stdout: 'a'.repeat(40), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await getGitRangeDiff('/repo', 'main', 'feature', 'src/file.ts');
    await getGitRangeFiles('/repo', 'main', 'feature');

    const calls = executeGit.mock.calls.map(([args]) => args);
    expect(calls).toContainEqual(['diff', '--no-color', '-U3', 'main...feature', '--', 'src/file.ts']);
    expect(calls).toContainEqual(['diff', '--name-only', 'main...feature']);
    expect(calls).not.toContainEqual(['diff', '--no-color', '-U3', 'origin/main...feature', '--', 'src/file.ts']);
    expect(calls).not.toContainEqual(['diff', '--name-only', 'origin/main...feature']);
  });

  it('blocks every starting operation while a merge marker exists', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-operation-marker-'));
    temporaryDirectories.push(directory);
    const markerPath = path.join(directory, 'MERGE_HEAD');
    await fs.writeFile(markerPath, 'a'.repeat(40));
    executeGit.mockImplementation(async (args) => (
      args.join('\0').startsWith('rev-parse\0--git-path')
        ? { stdout: `${markerPath}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 }
    ));

    await expect(merge(directory, { branch: 'main' })).rejects.toThrow(/^\[operation_in_progress\]/);
    await expect(rebase(directory, { onto: 'main' })).rejects.toThrow(/^\[operation_in_progress\]/);
    await expect(cherryPick(directory, 'a'.repeat(40))).rejects.toThrow(/^\[operation_in_progress\]/);
    await expect(revertCommit(directory, 'a'.repeat(40))).rejects.toThrow(/^\[operation_in_progress\]/);
  });
});
