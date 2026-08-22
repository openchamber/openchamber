import { beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnCalls = [];
const commandResponses = new Map();
const mockSpawn = mock((command, args, options) => {
  spawnCalls.push({ command, args: [...args], options });

  const stdoutHandlers = [];
  const stderrHandlers = [];
  const closeHandlers = [];
  const errorHandlers = [];

  const proc = {
    stdout: {
      on(event, handler) {
        if (event === 'data') stdoutHandlers.push(handler);
      },
    },
    stderr: {
      on(event, handler) {
        if (event === 'data') stderrHandlers.push(handler);
      },
    },
    on(event, handler) {
      if (event === 'close') closeHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
  };

  queueMicrotask(() => {
    const response = commandResponses.get(args.join('\u0000')) || { stdout: '', stderr: '', exitCode: 0 };
    if (response.error) {
      for (const handler of errorHandlers) handler(response.error);
      return;
    }
    if (response.stdout) {
      for (const handler of stdoutHandlers) handler(Buffer.from(response.stdout));
    }
    if (response.stderr) {
      for (const handler of stderrHandlers) handler(Buffer.from(response.stderr));
    }
    for (const handler of closeHandlers) handler(response.exitCode ?? 0);
  });

  return proc;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  execFile: mock(() => {
    throw new Error('execFile should not be used in git tag tests');
  }),
}));

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createTag } = await import('./gitService.ts?tag-test');

const setGitResponse = (args, response = { stdout: '', stderr: '', exitCode: 0 }) => {
  commandResponses.set(args.join('\u0000'), response);
};

describe('VS Code git tag service validation', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    commandResponses.clear();
    process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test.sock';
  });

  it('rejects option-like tag names before invoking git', async () => {
    await expect(createTag('/repo', '-d', '0123456789abcdef0123456789abcdef01234567')).rejects.toThrow('Invalid tag name');
    expect(spawnCalls).toHaveLength(0);
  });

  it('rejects NUL-delimited tag names before invoking git', async () => {
    await expect(createTag('/repo', 'bad\0tag', '0123456789abcdef0123456789abcdef01234567')).rejects.toThrow('Invalid tag name');
    expect(spawnCalls).toHaveLength(0);
  });

  it('rejects invalid commit hashes before invoking git', async () => {
    await expect(createTag('/repo', 'v1.2.3', 'not-a-hash')).rejects.toThrow('Invalid commit hash');
    expect(spawnCalls).toHaveLength(0);
  });

  it('passes tag creation arguments after -- in the raw git fallback', async () => {
    setGitResponse(['tag', '--', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567']);

    await expect(createTag('/repo', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567')).resolves.toEqual({ success: true, tag: 'v1.2.3' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual(['tag', '--', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567']);
  });
});
