import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';

const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK = '/tmp/openchamber-git-batching-test.sock';

const processState = {
  calls: [],
  addCallCount: 0,
  failOnAddCall: null,
  stagedOutput: '',
};

const spawn = mock((_command, args) => {
  const commandArgs = [...args];
  processState.calls.push(commandArgs);
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();

  const isFailedAdd = commandArgs[0] === 'add' && (++processState.addCallCount === processState.failOnAddCall);
  const stdout = commandArgs[0] === 'diff' ? processState.stagedOutput : (
    commandArgs[0] === 'rev-parse' && commandArgs[1] === 'HEAD'
      ? 'abc123\n'
      : commandArgs[0] === 'rev-parse'
        ? 'main\n'
        : ''
  );

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
  spawn.mockClear();
};

const getPathBatches = (command, prefix) => processState.calls
  .filter((args) => args[0] === command && prefix.every((value, index) => args[index + 1] === value))
  .map((args) => args.slice(prefix.length + 1));

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

  it('keeps oversized selected commits out of a single git commit argv', async () => {
    const selectedPaths = createOversizedPaths('selected');
    const unrelatedPaths = createOversizedPaths('unrelated');
    processState.stagedOutput = `${unrelatedPaths.join('\n')}\n`;

    const result = await createGitCommit('/repo', 'Commit selected paths', { files: selectedPaths });

    expect(result).toMatchObject({ success: true, commit: 'abc123', branch: 'main' });
    expect(processState.calls.find((args) => args[0] === 'commit')).toEqual([
      'commit',
      '-m',
      'Commit selected paths',
    ]);
    expect(getPathBatches('restore', ['--staged', '--']).length).toBeGreaterThan(1);
    expect(getPathBatches('add', ['--']).length).toBeGreaterThan(1);
  });
});
