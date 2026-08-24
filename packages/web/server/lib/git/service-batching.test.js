import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commit, stageFiles, unstageFiles } from './service.js';

const tempDirs = [];

const runGit = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const createRepository = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-batching-'));
  tempDirs.push(directory);
  runGit(directory, ['init']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(directory, 'README.md'), '# Test\n');
  runGit(directory, ['add', '--', 'README.md']);
  runGit(directory, ['commit', '-m', 'Initial commit']);
  return directory;
};

const createOversizedPaths = (prefix, count = 96) => Array.from(
  { length: count },
  (_, index) => `${prefix}-${String(index).padStart(3, '0')}-${'x'.repeat(112)}.txt`,
);

const writeFiles = (directory, filePaths) => {
  for (const filePath of filePaths) {
    fs.writeFileSync(path.join(directory, filePath), `${filePath}\n`);
  }
};

const captureGitTrace = async (callback) => {
  const traceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-trace-'));
  tempDirs.push(traceDirectory);
  const tracePath = path.join(traceDirectory, 'git.trace');
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = tracePath;

  try {
    await callback();
  } finally {
    if (previousTrace === undefined) {
      delete process.env.GIT_TRACE;
    } else {
      process.env.GIT_TRACE = previousTrace;
    }
  }

  return fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
};

const getTracedCommands = (traceLines, command) => traceLines.filter((line) => line.includes(`git ${command}`));

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('git path batching', () => {
  it('keeps a small stage and unstage selection in one Git command', async () => {
    const directory = createRepository();
    const filePaths = ['small.txt'];
    writeFiles(directory, filePaths);

    const stageTrace = await captureGitTrace(() => stageFiles(directory, filePaths));
    expect(getTracedCommands(stageTrace, 'add --')).toHaveLength(1);

    const unstageTrace = await captureGitTrace(() => unstageFiles(directory, filePaths));
    expect(getTracedCommands(unstageTrace, 'restore --staged --')).toHaveLength(1);
  });

  it('splits oversized stage and unstage selections into multiple Git argv calls', async () => {
    const directory = createRepository();
    const filePaths = createOversizedPaths('change');
    writeFiles(directory, filePaths);

    const stageTrace = await captureGitTrace(() => stageFiles(directory, filePaths));
    expect(getTracedCommands(stageTrace, 'add --')).toHaveLength(2);
    expect(runGit(directory, ['diff', '--cached', '--name-only']).trim().split('\n').sort()).toEqual([...filePaths].sort());

    const unstageTrace = await captureGitTrace(() => unstageFiles(directory, filePaths));
    expect(getTracedCommands(unstageTrace, 'restore --staged --')).toHaveLength(2);
    expect(runGit(directory, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('rejects a later stage batch instead of reporting the whole selection as successful', async () => {
    const directory = createRepository();
    const filePaths = createOversizedPaths('failure');
    writeFiles(directory, filePaths);
    fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(directory, 'ignored.txt'), 'ignored\n');

    await expect(stageFiles(directory, [...filePaths, 'ignored.txt'])).rejects.toThrow(
      'Staging selected files stopped after completing',
    );

    const stagedPaths = runGit(directory, ['diff', '--cached', '--name-only']).trim().split('\n');
    expect(stagedPaths.length).toBeGreaterThan(0);
    expect(stagedPaths.length).toBeLessThan(filePaths.length + 1);
  });

  it('keeps oversized selected commits out of a single git commit argv', async () => {
    const directory = createRepository();
    const selectedPaths = createOversizedPaths('selected');
    const unrelatedPaths = createOversizedPaths('unrelated');
    writeFiles(directory, [...selectedPaths, ...unrelatedPaths]);
    await stageFiles(directory, [...selectedPaths, ...unrelatedPaths]);

    const commitTrace = await captureGitTrace(() => commit(directory, 'Commit selected paths', { files: selectedPaths }));

    const commitCommands = getTracedCommands(commitTrace, 'commit -m');
    expect(commitCommands).toHaveLength(1);
    expect(commitCommands[0]).not.toContain(selectedPaths[0]);
    expect(getTracedCommands(commitTrace, 'restore --staged --')).toHaveLength(2);
    expect(getTracedCommands(commitTrace, 'add --')).toHaveLength(2);

    const committedPaths = runGit(directory, ['show', '--format=', '--name-only', 'HEAD'])
      .trim()
      .split('\n')
      .sort();
    const stillStagedPaths = runGit(directory, ['diff', '--cached', '--name-only'])
      .trim()
      .split('\n')
      .sort();
    expect(committedPaths).toEqual([...selectedPaths].sort());
    expect(stillStagedPaths).toEqual([...unrelatedPaths].sort());
  });
});
