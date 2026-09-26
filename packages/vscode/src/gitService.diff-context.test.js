import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gitTargetResult = {
  stdout: '100644 abc123\tfile.txt\0',
  stderr: '',
  exitCode: 0,
};

const execGit = mock(async (args) => (
  args[0] === 'diff'
    ? { stdout: 'patch', stderr: '', exitCode: 0 }
    : gitTargetResult
));

mock.module('vscode', () => ({
  extensions: {
    getExtension: () => undefined,
  },
}));
mock.module('./bridge-git-process-runtime', () => ({ execGit }));

const { getGitDiff } = await import('./gitService.ts?diff-context-test');

describe('VS Code Git diff context arguments', () => {
  it('uses the default context for omitted values and preserves explicit values', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-diff-'));
    fs.writeFileSync(path.join(directory, 'file.txt'), 'content');

    try {
      execGit.mockClear();
      await expect(getGitDiff(directory, 'file.txt')).resolves.toEqual({
        kind: 'diff',
        diff: 'patch',
        submodule: null,
      });
      expect(execGit).toHaveBeenLastCalledWith(
        ['diff', '-U3', '--', 'file.txt'],
        directory,
        { signal: undefined },
      );

      execGit.mockClear();
      await expect(getGitDiff(directory, 'file.txt', false, 12)).resolves.toEqual({
        kind: 'diff',
        diff: 'patch',
        submodule: null,
      });
      expect(execGit).toHaveBeenLastCalledWith(
        ['diff', '-U12', '--', 'file.txt'],
        directory,
        { signal: undefined },
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
