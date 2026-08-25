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
  } else if (command === 'rev-parse' && (
    commandArgs[1] === 'HEAD' || (commandArgs.includes('--verify') && commandArgs.includes('HEAD'))
  )) {
    stdout = 'abc123\n';
  } else if (command === 'rev-parse') {
    stdout = 'main\n';
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
    processState.statusOutput = `MM ${stagedOnlyPath}\nD  ${stagedDeletionPath}\n`;
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

  it('keeps explicit stageFiles on the existing index-managed selected-commit path', async () => {
    const selectedPaths = createOversizedPaths('selected');
    const unrelatedPaths = createOversizedPaths('unrelated');
    processState.stagedPathOutput = `${unrelatedPaths.join('\n')}\n`;

    const result = await createGitCommit('/repo', 'Commit selected paths', {
      files: selectedPaths,
      stageFiles: selectedPaths,
    });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    expect(processState.calls.find((args) => args[0] === 'commit')).toEqual([
      'commit',
      '-m',
      'Commit selected paths',
    ]);
    expect(processState.pathspecContents).toBeNull();
    expect(getPathBatches('restore', ['--staged', '--']).length).toBeGreaterThan(1);
    expect(getPathBatches('add', ['--']).length).toBeGreaterThan(1);
  });
});
