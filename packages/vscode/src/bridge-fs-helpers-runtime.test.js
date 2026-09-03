import { describe, expect, it, mock } from 'bun:test';

const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/repo' } }],
  findFiles: mock(async () => [{ fsPath: '/repo/visible.ts' }]),
  fs: {
    readDirectory: mock(async () => []),
  },
};

mock.module('vscode', () => ({
  workspace,
  Uri: {
    file: (fsPath) => ({ fsPath }),
    joinPath: (uri, name) => ({ fsPath: `${uri.fsPath}/${name}` }),
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  FileType: {
    Directory: 2,
    File: 1,
  },
}));

process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = '10';
const { parseGitCheckIgnoreResult, searchDirectory } = await import('./bridge-fs-helpers-runtime');
delete process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;

describe('filesystem Gitignore handling', () => {
  it('keeps no-match and confirmed non-repository results empty', () => {
    expect(parseGitCheckIgnoreResult({ stdout: '', stderr: '', exitCode: 1 }, '/repo')).toEqual(new Set());
    expect(parseGitCheckIgnoreResult({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    }, '/not-a-repo')).toEqual(new Set());
  });

  it('preserves spaces and embedded newlines in NUL-delimited output', () => {
    const ignoredNames = [' leading space', 'trailing space ', 'line\nbreak'];

    expect(parseGitCheckIgnoreResult({
      stdout: `${ignoredNames.join('\0')}\0`,
      stderr: '',
      exitCode: 0,
    }, '/repo')).toEqual(new Set(ignoredNames));
  });

  it('keeps authoritative parser failures observable', () => {
    expect(() => parseGitCheckIgnoreResult({
      stdout: '',
      stderr: 'EACCES: permission denied while checking Gitignore',
      exitCode: 1,
      code: 'EACCES',
    }, '/repo')).toThrow('Gitignore discovery failed');
  });

  it('returns unfiltered search results when Gitignore discovery fails', async () => {
    const runGitRead = mock(async () => ({
      stdout: '',
      stderr: 'EACCES: permission denied while checking Gitignore (not a git repository)',
      exitCode: 1,
      code: 'EACCES',
    }));

    await expect(searchDirectory('/repo', 'visible', 60, false, true, runGitRead))
      .resolves.toEqual([
        { name: 'visible.ts', path: '/repo/visible.ts', relativePath: 'visible.ts', extension: 'ts' },
      ]);
    expect(runGitRead).toHaveBeenCalledTimes(1);
  });

  it('filters successful Gitignore results without changing filesystem search results', async () => {
    workspace.findFiles.mockImplementation(async () => [
      { fsPath: '/repo/ignored.ts' },
      { fsPath: '/repo/visible.ts' },
    ]);
    const runGitRead = mock(async () => ({
      stdout: 'ignored.ts\0',
      stderr: '',
      exitCode: 0,
    }));

    try {
      await expect(searchDirectory('/repo', 'ts', 60, false, true, runGitRead))
        .resolves.toEqual([
          { name: 'visible.ts', path: '/repo/visible.ts', relativePath: 'visible.ts', extension: 'ts' },
        ]);
    } finally {
      workspace.findFiles.mockImplementation(async () => [{ fsPath: '/repo/visible.ts' }]);
    }
  });

  it('returns unfiltered search results when Gitignore admission times out', async () => {
    const runGitRead = mock(async () => {
      throw Object.assign(new Error('Git execution queue wait timed out'), {
        code: 'GIT_EXECUTION_QUEUE_TIMEOUT',
      });
    });

    await expect(searchDirectory('/repo', 'visible', 60, false, true, runGitRead))
      .resolves.toEqual([
        { name: 'visible.ts', path: '/repo/visible.ts', relativePath: 'visible.ts', extension: 'ts' },
      ]);
  });
});
