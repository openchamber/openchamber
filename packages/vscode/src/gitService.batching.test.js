import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK = '/tmp/openchamber-git-batching-test.sock';

const processState = {
  calls: [],
  addCallCount: 0,
  failOnAddCall: null,
  stagedOutput: '',
  statusOutput: '',
  stagedPathOutput: '',
  workingTreePathOutput: '',
  pathspecContents: null,
  indexInfoByPath: new Map(),
  stdinInputs: [],
  environments: [],
  mergeHeadPresent: false,
  failCommit: false,
};

const spawn = mock((_command, args, options = {}) => {
  const commandArgs = [...args];
  const command = commandArgs[0] === '--literal-pathspecs' ? commandArgs[1] : commandArgs[0];
  processState.calls.push(commandArgs);
  processState.environments.push(options.env);
  const pathspecArgument = commandArgs.find((argument) => argument.startsWith('--pathspec-from-file='));
  if (pathspecArgument) {
    processState.pathspecContents = fs.readFileSync(pathspecArgument.slice('--pathspec-from-file='.length));
  }
  const process = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.end = (input) => {
    processState.stdinInputs.push(Buffer.from(input));
  };
  process.stdin = stdin;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();

  const isFailedAdd = command === 'add' && (++processState.addCallCount === processState.failOnAddCall);
  let stdout = '';
  let exitCode = 0;
  if (command === 'status') {
    stdout = processState.statusOutput;
  } else if (command === 'diff' && commandArgs.includes('--cached')) {
    stdout = processState.stagedPathOutput;
  } else if (command === 'diff' && commandArgs.includes('--no-renames')) {
    stdout = processState.workingTreePathOutput;
  } else if (command === 'diff') {
    stdout = processState.stagedOutput;
  } else if (command === 'ls-files') {
    const separatorIndex = commandArgs.indexOf('--');
    const requestedPaths = separatorIndex === -1 ? [] : commandArgs.slice(separatorIndex + 1);
    stdout = requestedPaths.map((filePath) => processState.indexInfoByPath.get(filePath) || '').join('');
  } else if (command === 'rev-parse' && commandArgs.includes('--verify') && commandArgs.includes('MERGE_HEAD')) {
    // No merge in progress by default; tests opt in via mergeHeadPresent.
    if (processState.mergeHeadPresent) {
      stdout = 'abc123\n';
    } else {
      exitCode = 1;
    }
  } else if (command === 'rev-parse' && (
    commandArgs[1] === 'HEAD' || (commandArgs.includes('--verify') && commandArgs.includes('HEAD'))
  )) {
    stdout = 'abc123\n';
  } else if (command === 'rev-parse') {
    stdout = 'main\n';
  } else if (command === 'commit' && processState.failCommit) {
    exitCode = 1;
  }

  queueMicrotask(() => {
    if (stdout) {
      process.stdout.emit('data', Buffer.from(stdout));
    }
    if (isFailedAdd) {
      process.stderr.emit('data', Buffer.from('simulated batch failure'));
      process.emit('close', 1);
      return;
    }
    if (exitCode !== 0) {
      process.stderr.emit('data', Buffer.from('simulated failure'));
      process.emit('close', exitCode);
      return;
    }
    process.emit('close', 0);
  });
  return process;
});

mock.module('child_process', () => ({
  spawn,
  execFile: mock(),
}));

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createGitCommit, stageGitFiles, unstageGitFiles } = await import('./gitService.ts?batching-test');

const createOversizedPaths = (prefix, count = 96) => Array.from(
  { length: count },
  (_, index) => `${prefix}-${String(index).padStart(3, '0')}-${'x'.repeat(112)}.txt`,
);

const resetProcessState = () => {
  processState.calls.length = 0;
  processState.addCallCount = 0;
  processState.failOnAddCall = null;
  processState.stagedOutput = '';
  processState.statusOutput = '';
  processState.stagedPathOutput = '';
  processState.workingTreePathOutput = '';
  processState.pathspecContents = null;
  processState.indexInfoByPath.clear();
  processState.stdinInputs.length = 0;
  processState.environments.length = 0;
  processState.mergeHeadPresent = false;
  processState.failCommit = false;
  spawn.mockClear();
};

const getPathBatches = (command, prefix) => processState.calls
  .filter((args) => args[0] === command && prefix.every((value, index) => args[index + 1] === value))
  .map((args) => args.slice(prefix.length + 1));

const getCommandCalls = (command) => processState.calls
  .map((args, index) => ({ args, environment: processState.environments[index] }))
  .filter((call) => (call.args[0] === '--literal-pathspecs' ? call.args[1] : call.args[0]) === command);

beforeEach(resetProcessState);

afterAll(() => {
  if (originalSshAuthSock === undefined) {
    delete process.env.SSH_AUTH_SOCK;
  } else {
    process.env.SSH_AUTH_SOCK = originalSshAuthSock;
  }
});

describe('VS Code git path batching', () => {
  it('keeps a small stage and unstage selection in one Git command', async () => {
    const filePaths = ['small.txt'];

    await stageGitFiles('/repo', filePaths);
    expect(getPathBatches('add', ['--'])).toEqual([filePaths]);

    resetProcessState();
    await unstageGitFiles('/repo', filePaths);
    expect(getPathBatches('restore', ['--staged', '--'])).toEqual([filePaths]);
  });

  it('splits oversized stage and unstage selections into bounded Git argv calls', async () => {
    const filePaths = createOversizedPaths('change');

    await stageGitFiles('/repo', filePaths);

    const stageBatches = getPathBatches('add', ['--']);
    expect(stageBatches.length).toBeGreaterThan(1);
    expect(stageBatches.flat()).toEqual(filePaths);

    resetProcessState();
    await unstageGitFiles('/repo', filePaths);

    const unstageBatches = getPathBatches('restore', ['--staged', '--']);
    expect(unstageBatches.length).toBeGreaterThan(1);
    expect(unstageBatches.flat()).toEqual(filePaths);
  });

  it('rejects a later stage batch instead of reporting the whole selection as successful', async () => {
    const filePaths = createOversizedPaths('failure');
    processState.failOnAddCall = 2;

    await expect(stageGitFiles('/repo', filePaths)).rejects.toThrow(
      'Staging selected files stopped after completing',
    );

    expect(getPathBatches('add', ['--'])).toHaveLength(2);
  });

  it('builds a temporary index from selected entries for oversized generic commits', async () => {
    const selectedPaths = createOversizedPaths('selected');
    const stagedOnlyPath = ':selected-stage-only.txt';
    const stagedDeletionPath = ':selected-deleted.txt';
    const selectedFiles = [...selectedPaths, stagedOnlyPath, stagedDeletionPath];
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    // Untracked selected paths appear in git status as `??` entries; the
    // status filter keeps them for staging.
    processState.statusOutput = [
      `MM ${stagedOnlyPath}`,
      `D  ${stagedDeletionPath}`,
      ...selectedPaths.map((filePath) => `?? ${filePath}`),
    ].join('\n') + '\n';
    for (const filePath of selectedFiles.filter((filePath) => filePath !== stagedDeletionPath)) {
      processState.indexInfoByPath.set(filePath, indexInfoForPath(filePath));
    }

    const result = await createGitCommit('/repo', 'Commit selected paths', { files: selectedFiles });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    expect(getCommandCalls('commit')).toEqual([{
      args: [
        'commit',
        '-m',
        'Commit selected paths',
      ],
      environment: expect.objectContaining({
        GIT_INDEX_FILE: expect.stringMatching(/openchamber-git-pathspec-/),
      }),
    }]);
    expect(processState.pathspecContents).toEqual(Buffer.from(`${stagedDeletionPath}\0`, 'utf8'));
    expect(getPathBatches('restore', ['--staged', '--'])).toHaveLength(0);
    expect(getPathBatches('add', ['--']).flat()).toEqual(selectedPaths);

    const [headReadTree, readTree] = getCommandCalls('read-tree');
    const [remove] = getCommandCalls('rm');
    const [updateIndex] = getCommandCalls('update-index');
    const [commit] = getCommandCalls('commit');
    expect(headReadTree).toEqual(expect.objectContaining({
      args: ['read-tree', 'HEAD'],
      environment: expect.objectContaining({
        GIT_INDEX_FILE: expect.stringMatching(/openchamber-git-index-/),
      }),
    }));
    expect(readTree).toEqual(expect.objectContaining({
      args: ['read-tree', 'HEAD'],
      environment: expect.objectContaining({
        GIT_INDEX_FILE: expect.stringMatching(/openchamber-git-pathspec-/),
      }),
    }));
    expect(remove.args).toEqual([
      '--literal-pathspecs',
      'rm',
      '--cached',
      '--ignore-unmatch',
      expect.stringMatching(/^--pathspec-from-file=/),
      '--pathspec-file-nul',
    ]);
    expect(remove.environment.GIT_INDEX_FILE).toBe(readTree.environment.GIT_INDEX_FILE);
    expect(updateIndex).toEqual(expect.objectContaining({
      args: ['update-index', '-z', '--index-info'],
      environment: expect.objectContaining({
        GIT_INDEX_FILE: expect.stringMatching(/openchamber-git-pathspec-/),
      }),
    }));
    expect(updateIndex.environment.GIT_INDEX_FILE).toBe(readTree.environment.GIT_INDEX_FILE);
    expect(commit.environment.GIT_INDEX_FILE).toBe(readTree.environment.GIT_INDEX_FILE);
    expect(processState.stdinInputs).toEqual([
      Buffer.from(selectedFiles
        .filter((filePath) => filePath !== stagedDeletionPath)
        .map(indexInfoForPath)
        .join(''), 'utf8'),
    ]);
    const indexInfoCalls = getCommandCalls('ls-files');
    expect(indexInfoCalls.length).toBeGreaterThan(1);
    expect(indexInfoCalls.flatMap((call) => call.args.slice(call.args.indexOf('--') + 1))).toEqual(selectedFiles);
    expect(getCommandCalls('write-tree')).toHaveLength(0);
  });

  it('uses a temporary index for explicit stageFiles without rewriting unrelated newline paths', async () => {
    const stagedOnlySelectedPath = 'selected-stage-only.txt';
    const stagedDeletedSelectedPath = 'selected-deleted.txt';
    const stagedUntrackedPath = 'selected-stage-file.txt';
    const unrelatedPartialPath = 'unrelated-partial-stage.txt';
    const unrelatedNewlinePath = 'unrelated\npartial-stage.txt';
    const selectedPaths = [stagedOnlySelectedPath, stagedDeletedSelectedPath];
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    processState.stagedPathOutput = `${unrelatedPartialPath}\n${unrelatedNewlinePath}\n`;
    processState.statusOutput = [
      `MM ${stagedOnlySelectedPath}`,
      `D  ${stagedDeletedSelectedPath}`,
      `?? ${stagedUntrackedPath}`,
    ].join('\n') + '\n';
    processState.indexInfoByPath.set(stagedOnlySelectedPath, indexInfoForPath(stagedOnlySelectedPath));
    processState.indexInfoByPath.set(stagedUntrackedPath, indexInfoForPath(stagedUntrackedPath));

    const result = await createGitCommit('/repo', 'Commit selected paths', {
      files: selectedPaths,
      stageFiles: [stagedUntrackedPath],
    });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    expect(getCommandCalls('commit')).toEqual([expect.objectContaining({
      args: ['commit', '-m', 'Commit selected paths'],
      environment: expect.objectContaining({
        GIT_INDEX_FILE: expect.stringMatching(/openchamber-git-pathspec-/),
      }),
    })]);
    expect(getCommandCalls('diff').filter((call) => call.args.includes('--cached'))).toHaveLength(0);
    expect(getPathBatches('restore', ['--staged', '--'])).toHaveLength(0);
    expect(getPathBatches('add', ['--'])).toEqual([[stagedUntrackedPath]]);

    const indexInfoCalls = getCommandCalls('ls-files');
    expect(indexInfoCalls).toEqual([expect.objectContaining({
      args: [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        ...selectedPaths,
        stagedUntrackedPath,
      ],
    })]);
    expect(processState.pathspecContents).toEqual(Buffer.from(`${stagedDeletedSelectedPath}\0`, 'utf8'));
    expect(getCommandCalls('write-tree')).toHaveLength(0);
  });

  it('carries the old path of a selected staged rename into the temporary-index removal list', async () => {
    const oldPath = 'renamed-old.txt';
    const newPath = 'renamed-new.txt';
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    // `git status --porcelain -z` emits the staged rename as two NUL-terminated
    // records: `R  new-path\0old-path\0`.
    processState.statusOutput = `R  ${newPath}\0${oldPath}\0`;
    processState.indexInfoByPath.set(newPath, indexInfoForPath(newPath));

    const result = await createGitCommit('/repo', 'Commit staged rename', {
      files: [newPath],
      stageFiles: [],
    });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    // The old path is not in the index, so it must be added to the removal
    // pathspec file alongside the missing-from-index destinations.
    expect(processState.pathspecContents).toEqual(Buffer.from(`${oldPath}\0`, 'utf8'));
    expect(getCommandCalls('write-tree')).toHaveLength(0);
  });

  it('does not carry a copy source into the temporary-index removal list', async () => {
    const sourcePath = 'copied-old.txt';
    const copiedPath = 'copied-new.txt';
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    // `git status --porcelain -z` emits a staged copy as two NUL-terminated
    // records: `C  new-path\0old-path\0` (only when status.renames=copies is
    // set). A copy leaves its source in the index, so the source must stay in
    // the selected commit.
    processState.statusOutput = `C  ${copiedPath}\0${sourcePath}\0`;
    processState.indexInfoByPath.set(copiedPath, indexInfoForPath(copiedPath));
    processState.indexInfoByPath.set(sourcePath, indexInfoForPath(sourcePath));

    const result = await createGitCommit('/repo', 'Commit staged copy', {
      files: [copiedPath],
      stageFiles: [],
    });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    // The copy source stays in the index, so it must NOT be added to the
    // removal pathspec file.
    expect(processState.pathspecContents).toBeNull();
    expect(getCommandCalls('write-tree')).toHaveLength(0);
  });

  it('refuses a selected commit while a merge is in progress', async () => {
    const selectedPath = 'merge-guard-selected.txt';
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    processState.statusOutput = `MM ${selectedPath}\n`;
    processState.indexInfoByPath.set(selectedPath, indexInfoForPath(selectedPath));
    processState.mergeHeadPresent = true;

    await expect(createGitCommit('/repo', 'Commit during merge', {
      files: [selectedPath],
      stageFiles: [],
    })).rejects.toThrow('Selected commit refused while a merge is in progress');

    // The guard must fire before any temporary-index command runs.
    expect(getCommandCalls('read-tree')).toHaveLength(0);
    expect(getCommandCalls('commit')).toHaveLength(0);
  });

  it('drops explicit stageFiles paths that are absent from git status', async () => {
    const selectedPath = 'selected-staged.txt';
    const staleStagePath = 'stale-stage.txt';
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    processState.statusOutput = `MM ${selectedPath}\n`;
    processState.indexInfoByPath.set(selectedPath, indexInfoForPath(selectedPath));
    processState.indexInfoByPath.set(staleStagePath, indexInfoForPath(staleStagePath));

    const result = await createGitCommit('/repo', 'Commit selected paths', {
      files: [selectedPath],
      stageFiles: [selectedPath, staleStagePath],
    });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    // Only the path present in status is staged; the stale path is filtered
    // out before stageGitFiles runs.
    expect(getPathBatches('add', ['--'])).toEqual([[selectedPath]]);
    expect(getCommandCalls('write-tree')).toHaveLength(0);
  });

  it('surfaces git stderr when the temporary-index commit fails', async () => {
    const selectedPath = 'failing-commit.txt';
    const indexInfoForPath = (filePath) => `100644 ${'a'.repeat(40)} 0\t${filePath}\0`;
    processState.statusOutput = `MM ${selectedPath}\n`;
    processState.indexInfoByPath.set(selectedPath, indexInfoForPath(selectedPath));
    processState.failCommit = true;

    await expect(createGitCommit('/repo', 'Commit selected paths', {
      files: [selectedPath],
      stageFiles: [],
    })).rejects.toThrow('simulated failure');
  });
});
