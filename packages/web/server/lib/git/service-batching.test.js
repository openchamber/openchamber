import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commit, stageFiles, unstageFiles } from './service.js';

const tempDirs = [];

const runGit = (cwd, args, input) => execFileSync('git', args, {
  cwd,
  input,
  encoding: 'utf8',
  stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
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

const getPartialStageContents = () => {
  const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const staged = original.replace('line 1', 'staged line 1');
  const working = staged.replace('line 20', 'unstaged line 20');
  return { original, staged, working };
};

const stageOneUnrelatedHunk = (directory, filePath) => {
  const { staged, working } = getPartialStageContents();
  fs.writeFileSync(path.join(directory, filePath), staged);
  runGit(directory, ['add', '--', filePath]);
  fs.writeFileSync(path.join(directory, filePath), working);

  return getPartialStageContents();
};

const getStageOnlyContents = () => {
  const original = 'original selected content\n';
  const staged = 'staged selected content\n';
  return { original, staged };
};

const stageOnlySelectedFile = (directory, filePath) => {
  const { original, staged } = getStageOnlyContents();
  fs.writeFileSync(path.join(directory, filePath), staged);
  runGit(directory, ['add', '--', filePath]);
  fs.writeFileSync(path.join(directory, filePath), original);

  return getStageOnlyContents();
};

const createUnmergedIndexEntries = (directory, filePath) => {
  const hashes = ['base', 'ours', 'theirs'].map((content) => runGit(
    directory,
    ['hash-object', '-w', '--stdin'],
    `${content}\n`,
  ).trim());
  const zeroHash = '0'.repeat(40);
  const writeIndexInfo = (entry) => runGit(
    directory,
    ['update-index', '-z', '--index-info'],
    Buffer.from(entry, 'utf8'),
  );

  writeIndexInfo(`0 ${zeroHash}\t${filePath}\0`);
  hashes.forEach((hash, index) => {
    writeIndexInfo(`100644 ${hash} ${index + 1}\t${filePath}\0`);
  });
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

  it('commits explicit stageFiles without rewriting unrelated partial or newline index entries', async () => {
    const directory = createRepository();
    const stagedOnlySelectedPath = 'selected-stage-only.txt';
    const stagedDeletedSelectedPath = 'selected-deleted.txt';
    const stagedUntrackedPath = 'selected\nstage-file.txt';
    const partiallyStagedPath = 'unrelated-partial-stage.txt';
    const newlinePartiallyStagedPath = 'unrelated\npartial-stage.txt';
    const selectedStage = getStageOnlyContents();
    const partialStage = getPartialStageContents();

    for (const filePath of [
      stagedOnlySelectedPath,
      stagedDeletedSelectedPath,
      partiallyStagedPath,
      newlinePartiallyStagedPath,
    ]) {
      fs.writeFileSync(path.join(directory, filePath), filePath.startsWith('selected')
        ? selectedStage.original
        : partialStage.original);
    }
    runGit(directory, ['add', '--', stagedOnlySelectedPath, stagedDeletedSelectedPath, partiallyStagedPath, newlinePartiallyStagedPath]);
    runGit(directory, ['commit', '-m', 'Add explicit stageFiles fixtures']);

    const stagedOnlySelected = stageOnlySelectedFile(directory, stagedOnlySelectedPath);
    runGit(directory, ['rm', '--', stagedDeletedSelectedPath]);
    const unrelatedPartialStage = stageOneUnrelatedHunk(directory, partiallyStagedPath);
    const unrelatedNewlinePartialStage = stageOneUnrelatedHunk(directory, newlinePartiallyStagedPath);
    const unrelatedPartialIndex = runGit(directory, ['ls-files', '--stage', '-z', '--', partiallyStagedPath]);
    const unrelatedNewlinePartialIndex = runGit(directory, ['ls-files', '--stage', '-z', '--', newlinePartiallyStagedPath]);
    fs.writeFileSync(path.join(directory, stagedUntrackedPath), 'selected untracked content\n');

    const commitTrace = await captureGitTrace(() => commit(directory, 'Commit explicit stageFiles', {
      files: [stagedOnlySelectedPath, stagedDeletedSelectedPath],
      stageFiles: [stagedUntrackedPath],
    }));

    const committedPaths = runGit(directory, ['show', '--format=', '--name-only', '-z', 'HEAD'])
      .split('\0')
      .filter(Boolean)
      .sort();
    const stillStagedPaths = runGit(directory, ['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(committedPaths).toEqual([stagedOnlySelectedPath, stagedDeletedSelectedPath, stagedUntrackedPath].sort());
    expect(stillStagedPaths).toEqual([partiallyStagedPath, newlinePartiallyStagedPath].sort());
    expect(getTracedCommands(commitTrace, 'restore --staged --')).toHaveLength(0);
    expect(getTracedCommands(commitTrace, 'write-tree')).toHaveLength(0);
    expect(runGit(directory, ['show', `HEAD:${stagedOnlySelectedPath}`])).toBe(stagedOnlySelected.staged);
    expect(runGit(directory, ['show', `HEAD:${stagedUntrackedPath}`])).toBe('selected untracked content\n');
    expect(() => runGit(directory, ['show', `HEAD:${stagedDeletedSelectedPath}`])).toThrow();
    expect(runGit(directory, ['ls-files', '--stage', '-z', '--', partiallyStagedPath])).toBe(unrelatedPartialIndex);
    expect(runGit(directory, ['ls-files', '--stage', '-z', '--', newlinePartiallyStagedPath])).toBe(unrelatedNewlinePartialIndex);
    expect(runGit(directory, ['show', `:${partiallyStagedPath}`])).toBe(unrelatedPartialStage.staged);
    expect(runGit(directory, ['show', `:${newlinePartiallyStagedPath}`])).toBe(unrelatedNewlinePartialStage.staged);
    expect(fs.readFileSync(path.join(directory, partiallyStagedPath), 'utf8')).toBe(unrelatedPartialStage.working);
    expect(fs.readFileSync(path.join(directory, newlinePartiallyStagedPath), 'utf8')).toBe(unrelatedNewlinePartialStage.working);
  });

  it('commits oversized staged-only selected paths while preserving unrelated partial staging and intent-to-add entries', async () => {
    const directory = createRepository();
    const selectedPaths = createOversizedPaths('selected');
    const stagedOnlySelectedPath = 'selected-stage-only.txt';
    const stagedOnlyDeletedPath = 'selected\nstage-only-deleted.txt';
    const unrelatedPaths = createOversizedPaths('unrelated');
    const partiallyStagedPath = 'unrelated-partial-stage.txt';
    const newlineUnrelatedPath = 'unrelated\nnewline.txt';
    const intentToAddPath = 'unrelated\nintent-to-add.txt';
    const initialPartialStage = getPartialStageContents();
    const initialSelectedStage = getStageOnlyContents();
    fs.writeFileSync(path.join(directory, partiallyStagedPath), initialPartialStage.original);
    fs.writeFileSync(path.join(directory, stagedOnlySelectedPath), initialSelectedStage.original);
    fs.writeFileSync(path.join(directory, stagedOnlyDeletedPath), initialSelectedStage.original);
    runGit(directory, ['add', '--', partiallyStagedPath, stagedOnlySelectedPath, stagedOnlyDeletedPath]);
    runGit(directory, ['commit', '-m', 'Add commit batching fixtures']);
    const partialStage = stageOneUnrelatedHunk(directory, partiallyStagedPath);
    const selectedStage = stageOnlySelectedFile(directory, stagedOnlySelectedPath);
    runGit(directory, ['rm', '--', stagedOnlyDeletedPath]);
    writeFiles(directory, [...selectedPaths, ...unrelatedPaths, newlineUnrelatedPath]);
    await stageFiles(directory, [...unrelatedPaths, newlineUnrelatedPath]);
    fs.writeFileSync(path.join(directory, intentToAddPath), 'intent-to-add\n');
    runGit(directory, ['add', '-N', '--', intentToAddPath]);
    const intentToAddIndex = runGit(directory, ['ls-files', '--stage', '-z', '--', intentToAddPath]);

    const commitTrace = await captureGitTrace(() => commit(directory, 'Commit selected paths', {
      files: [...selectedPaths, stagedOnlySelectedPath, stagedOnlyDeletedPath],
    }));

    const commitCommands = getTracedCommands(commitTrace, 'commit -m');
    expect(commitCommands).toHaveLength(1);
    expect(commitCommands[0]).not.toContain(selectedPaths[0]);
    expect(commitCommands[0]).not.toContain('--pathspec-from-file=');
    expect(getTracedCommands(commitTrace, 'write-tree')).toHaveLength(0);
    expect(getTracedCommands(commitTrace, 'add --').some((command) => command.includes(stagedOnlySelectedPath))).toBe(false);

    const committedPaths = runGit(directory, ['show', '--format=', '--name-only', '-z', 'HEAD'])
      .split('\0')
      .filter(Boolean)
      .sort();
    const stillStagedPaths = runGit(directory, ['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(committedPaths).toEqual([...selectedPaths, stagedOnlySelectedPath, stagedOnlyDeletedPath].sort());
    expect(stillStagedPaths).toEqual([...unrelatedPaths, newlineUnrelatedPath, partiallyStagedPath].sort());
    expect(runGit(directory, ['show', `HEAD:${stagedOnlySelectedPath}`])).toBe(selectedStage.staged);
    expect(runGit(directory, ['show', `:${stagedOnlySelectedPath}`])).toBe(selectedStage.staged);
    expect(() => runGit(directory, ['show', `HEAD:${stagedOnlyDeletedPath}`])).toThrow();
    expect(fs.readFileSync(path.join(directory, stagedOnlySelectedPath), 'utf8')).toBe(selectedStage.original);
    expect(fs.existsSync(path.join(directory, stagedOnlyDeletedPath))).toBe(false);
    expect(runGit(directory, ['show', `:${partiallyStagedPath}`])).toBe(partialStage.staged);
    expect(fs.readFileSync(path.join(directory, partiallyStagedPath), 'utf8')).toBe(partialStage.working);
    expect(runGit(directory, ['ls-files', '--stage', '-z', '--', intentToAddPath])).toBe(intentToAddIndex);
    expect(fs.readFileSync(path.join(directory, intentToAddPath), 'utf8')).toBe('intent-to-add\n');
  });

  it('commits oversized selected paths without reading an unrelated unmerged index entry', async () => {
    const directory = createRepository();
    const selectedPaths = createOversizedPaths('selected');
    const stagedOnlySelectedPath = 'selected-stage-only.txt';
    const unmergedPath = 'unrelated\nconflict.txt';
    const selectedStage = getStageOnlyContents();
    fs.writeFileSync(path.join(directory, stagedOnlySelectedPath), selectedStage.original);
    fs.writeFileSync(path.join(directory, unmergedPath), 'conflict base\n');
    runGit(directory, ['add', '--', stagedOnlySelectedPath, unmergedPath]);
    runGit(directory, ['commit', '-m', 'Add unmerged batching fixtures']);
    stageOnlySelectedFile(directory, stagedOnlySelectedPath);
    writeFiles(directory, selectedPaths);
    createUnmergedIndexEntries(directory, unmergedPath);
    const unmergedIndex = runGit(directory, ['ls-files', '--unmerged', '-z']);

    const commitTrace = await captureGitTrace(() => commit(directory, 'Commit selected paths', {
      files: [...selectedPaths, stagedOnlySelectedPath],
    }));

    const committedPaths = runGit(directory, ['show', '--format=', '--name-only', '-z', 'HEAD'])
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(committedPaths).toEqual([...selectedPaths, stagedOnlySelectedPath].sort());
    expect(getTracedCommands(commitTrace, 'write-tree')).toHaveLength(0);
    expect(runGit(directory, ['ls-files', '--unmerged', '-z'])).toBe(unmergedIndex);
    expect(runGit(directory, ['show', `HEAD:${stagedOnlySelectedPath}`])).toBe(selectedStage.staged);
    expect(fs.readFileSync(path.join(directory, stagedOnlySelectedPath), 'utf8')).toBe(selectedStage.original);
    expect(fs.readFileSync(path.join(directory, unmergedPath), 'utf8')).toBe('conflict base\n');
  });
});
