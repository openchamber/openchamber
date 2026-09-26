import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  execFileProcessTree,
  killProcessTree,
  withProcessTreeOwnership,
} from './process-tree.js';

describe('Git process-tree ownership', () => {
  it.each(['status', 'diff'])('terminates a hanging %s read and its descendant on idle timeout', async (operation) => {
    if (process.platform === 'win32') return;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('');
    let failure;
    try {
      await execFileProcessTree({
        command: process.execPath,
        args: ['-e', script, operation],
        idleTimeout: 20,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
    const descendantPid = Number(String(failure?.stdout || '').trim());
    expect(Number.isInteger(descendantPid)).toBe(true);
    const descendantIsAlive = () => {
      try {
        process.kill(descendantPid, 0);
        if (process.platform === 'linux') {
          const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
          const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
          return state !== 'Z';
        }
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 200 && descendantIsAlive(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(descendantIsAlive()).toBe(false);
  });

  it('preserves normal Windows taskkill cleanup while the owned root is live', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    let settled = false;
    void termination.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );

    taskkill.emit('close', 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 137, null);
    await termination;
    expect(settled).toBe(true);
  });

  it('does not target an already-closed Windows PID that may have been reused', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.exitCode = 0;
    child.signalCode = null;
    child.kill = vi.fn();
    const spawn = vi.fn();

    await expect(killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: true,
      cleanupReconciliation: undefined,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rechecks the Windows root before spawning taskkill', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    let exitCodeReads = 0;
    Object.defineProperty(child, 'exitCode', {
      get: () => {
        exitCodeReads += 1;
        return exitCodeReads > 1 ? 0 : null;
      },
    });
    child.signalCode = null;
    child.kill = vi.fn();
    const spawn = vi.fn();

    await expect(killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: true,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for an owned POSIX child to close before resolving', async () => {
    const child = new EventEmitter();
    child.pid = 987654;
    child.kill = vi.fn();

    const termination = killProcessTree(child, {
      platform: 'linux',
      terminationTimeoutMs: 30,
    });
    let settled = false;
    void termination.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    child.emit('close', 137, 'SIGKILL');
    await termination;
    expect(settled).toBe(true);
  });

  it('reports bounded POSIX cleanup failure when the child never closes', async () => {
    const child = new EventEmitter();
    child.pid = 987656;
    child.kill = vi.fn();

    await expect(killProcessTree(child, {
      platform: 'linux',
      terminationTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
    });
  });

  it('retains a late close observer after bounded cleanup failure', async () => {
    const child = new EventEmitter();
    child.pid = 987657;
    child.kill = vi.fn();

    let failure;
    try {
      await killProcessTree(child, {
        platform: 'linux',
        terminationTimeoutMs: 5,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      cleanupReconciliation: { promise: expect.any(Promise) },
    });
    child.emit('close', 137, 'SIGKILL');
    await failure.cleanupReconciliation.promise;
  });

  it('reports a bounded confirmation failure when taskkill succeeds without root close', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    taskkill.emit('close', 0);

    await expect(termination).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
      cleanupBlocked: true,
      rootClosed: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports taskkill failure after attempting a bounded root fallback', async () => {
    const child = { pid: 1234, kill: vi.fn() };
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    taskkill.emit('error', new Error('taskkill unavailable'));

    await expect(termination).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports a nonzero taskkill exit without claiming tree cleanup', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    taskkill.emit('close', 1);

    await expect(termination).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
      cleanupBlocked: true,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports a taskkill spawn failure without claiming tree cleanup', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    const spawn = vi.fn(() => { throw new Error('taskkill spawn failed'); });

    await expect(killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
      cleanupBlocked: true,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports a taskkill timeout without claiming tree cleanup', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    const spawn = vi.fn(() => new EventEmitter());

    await expect(killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
      cleanupBlocked: true,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles cancellation when taskkill succeeds but the root never closes', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const controller = new AbortController();
    const spawn = vi.fn((command) => (command === 'taskkill' ? taskkill : child));

    const pending = execFileProcessTree({
      command: 'git',
      args: ['status'],
      signal: controller.signal,
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    controller.abort();
    taskkill.emit('close', 0);

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      operationError: { code: 'ABORT_ERR' },
      descendantsTerminated: false,
      cleanupBlocked: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('settles cancellation with an explicit cleanup failure when Windows taskkill fails', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const controller = new AbortController();
    const spawn = vi.fn((command) => (command === 'taskkill' ? taskkill : child));

    const pending = execFileProcessTree({
      command: 'git',
      args: ['status'],
      signal: controller.signal,
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    controller.abort();
    taskkill.emit('error', new Error('taskkill failed'));

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      operationError: { code: 'ABORT_ERR' },
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles max-buffer cleanup with an explicit Windows termination failure', async () => {
    const child = new EventEmitter();
    child.pid = 1235;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const spawn = vi.fn((command) => (command === 'taskkill' ? taskkill : child));

    const pending = execFileProcessTree({
      command: 'git',
      args: ['status'],
      maxBuffer: 1,
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    child.stdout.emit('data', Buffer.from('12'));
    taskkill.emit('error', new Error('taskkill failed during max-buffer cleanup'));

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      operationError: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps POSIX children detached and signals their process group', () => {
    expect(withProcessTreeOwnership({ cwd: '/repo' }, 'linux')).toEqual({ cwd: '/repo', detached: true });
    expect(withProcessTreeOwnership({ cwd: 'C:\\repo' }, 'win32')).toEqual({ cwd: 'C:\\repo', detached: false });
  });

  it('preserves binary stdout for owned Git reads', async () => {
    const result = await execFileProcessTree({
      command: process.execPath,
      args: ['-e', "process.stdout.write(Buffer.from([0, 255, 17]))"],
      encoding: 'buffer',
    });
    expect(result.stdout).toEqual(Buffer.from([0, 255, 17]));
  });
});
