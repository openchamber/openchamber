import { describe, expect, it, vi } from 'vitest';

import {
  assertGitAvailable,
  looksLikeAuthError,
  runGit,
  runWithGitCloneReservation,
} from './git.js';
import { runWithGitExecutionScope } from '../git/execution-scope.js';

describe('skills catalog Git helpers', () => {
  it('passes non-interactive execution settings and identity configuration to Git', async () => {
    const execute = vi.fn(async (_command, _args, options) => {
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
      return { stdout: 'git version 2.0\n', stderr: '' };
    });

    await expect(runGit(['status'], {
      cwd: '/repo',
      identity: { sshKey: '/home/user/.ssh/id_ed25519' },
      timeoutMs: 123,
      maxBuffer: 456,
      execFileAsync: execute,
    })).resolves.toEqual({ ok: true, stdout: 'git version 2.0\n', stderr: '' });

    expect(execute).toHaveBeenCalledWith(
      'git',
      [
        '-c',
        "core.sshCommand=ssh -i '/home/user/.ssh/id_ed25519' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        'status',
      ],
      expect.objectContaining({ cwd: '/repo', timeout: 123, maxBuffer: 456 }),
    );
  });

  it('applies optional-lock suppression only inside the shared read scope', async () => {
    const execute = vi.fn(async (_command, _args, options) => ({ stdout: options.env.GIT_OPTIONAL_LOCKS || '', stderr: '' }));

    await expect(runWithGitExecutionScope(true, () => runGit(['show', 'HEAD'], {
      execFileAsync: execute,
    }))).resolves.toMatchObject({ stdout: '0' });
    await expect(runGit(['clone'], { execFileAsync: execute })).resolves.toMatchObject({ stdout: '' });
  });

  it('uses the configured Git binary and shared safe SSH command builder', async () => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await expect(runGit(['clone'], {
      identity: { sshKey: '/home/user/keys/my key' },
      resolveGitBinaryForSpawn: () => '/opt/custom git/bin/git',
      execFileAsync: execute,
    })).resolves.toMatchObject({ ok: true });

    expect(execute).toHaveBeenCalledWith(
      '/opt/custom git/bin/git',
      [
        '-c',
        "core.sshCommand=ssh -i '/home/user/keys/my key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        'clone',
      ],
      expect.any(Object),
    );
  });

  it('rejects shell metacharacters in SSH identity paths before spawning Git', async () => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await expect(runGit(['clone'], {
      identity: { sshKey: '/tmp/id; touch /tmp/should-not-run' },
      execFileAsync: execute,
    })).rejects.toThrow('SSH key path contains invalid characters');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves spawn and Git error details instead of converting them to success', async () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const execute = vi.fn(async () => { throw spawnError; });

    await expect(runGit(['--version'], { execFileAsync: execute })).resolves.toMatchObject({
      ok: false,
      message: 'spawn git ENOENT',
      code: 'ENOENT',
    });
    const runGitCommand = (args, options) => runGit(args, { ...options, execFileAsync: execute });
    await expect(assertGitAvailable(runGitCommand)).resolves.toEqual({
      ok: false,
      error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' },
    });
  });

  it('does not convert blocked process cleanup into Git unavailable', async () => {
    const blocked = {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 8080,
    };
    const runGitCommand = async () => ({ ok: false, message: 'cleanup blocked', ...blocked });

    await expect(assertGitAvailable(runGitCommand)).resolves.toMatchObject({
      ok: false,
      cleanupBlocked: true,
      descendantsTerminated: false,
      error: {
        kind: 'networkError',
        cleanupBlocked: true,
        descendantsTerminated: false,
        rootClosed: false,
        pid: 8080,
      },
    });
  });

  it('bounds output when the shared process-tree executor is used', async () => {
    await expect(runGit(['-e', "process.stderr.write('x'.repeat(5 * 1024 * 1024))"], {
      resolveGitBinaryForSpawn: () => process.execPath,
      timeoutMs: 5_000,
    })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/maxBuffer/i),
    });
  });

  it('recognizes authentication failures from either Git output or process errors', () => {
    expect(looksLikeAuthError('fatal: Authentication failed for origin')).toBe(true);
    expect(looksLikeAuthError('Permission denied (publickey).')).toBe(true);
    expect(looksLikeAuthError('spawn git ENOENT')).toBe(false);
  });

  it('uses the shared clone reservation when available and keeps the fallback local', async () => {
    const releaseNetwork = vi.fn();
    const task = vi.fn(async (lease) => {
      lease.releaseNetwork();
      return 'done';
    });
    const runClone = vi.fn(async (options, callback) => callback({ releaseNetwork }));

    await expect(runWithGitCloneReservation({
      destination: '/tmp/skills',
      label: 'skills-test',
      queueTimeoutMs: 10,
      gitExecutionService: { coordinator: { runClone } },
    }, task)).resolves.toBe('done');

    expect(runClone).toHaveBeenCalledWith({
      destination: '/tmp/skills',
      label: 'skills-test',
      queueTimeoutMs: 10,
    }, task);
    expect(releaseNetwork).toHaveBeenCalledOnce();
  });

  it('passes cancellation into clone admission', async () => {
    const controller = new AbortController();
    const runClone = vi.fn(async (options, callback) => callback({ releaseNetwork: vi.fn() }));

    await runWithGitCloneReservation({
      destination: '/tmp/skills',
      label: 'skills-test',
      queueTimeoutMs: 10,
      signal: controller.signal,
      gitExecutionService: { coordinator: { runClone } },
    }, async () => 'done');

    expect(runClone).toHaveBeenCalledWith({
      destination: '/tmp/skills',
      label: 'skills-test',
      queueTimeoutMs: 10,
      signal: controller.signal,
    }, expect.any(Function));
  });
});
