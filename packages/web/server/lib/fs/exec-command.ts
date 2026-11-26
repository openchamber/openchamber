import path from 'node:path';
import type { spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import type { CommandResult } from './exec-jobs.js';
import { createExecOutput } from './exec-output.js';

export interface CommandOptions {
  shell: string;
  shellFlag: string;
  command: string;
  resolvedCwd: string;
  maxOutputBytes: number;
}

export type CapturedCommandResult = CommandResult & { capturedBytes: number };

export interface KillCommandTreeOptions {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  systemRoot?: string | undefined;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const TASKKILL_WAIT_MS = 5_000;

const activeCommands = new Map<ChildProcess, typeof nodeSpawn>();
let admissionClosed = false;

export const killCommandTree = (child: ChildProcess, spawn: typeof nodeSpawn, {
  platform = process.platform,
  kill = (pid, signal) => process.kill(pid, signal),
  systemRoot = process.env.SystemRoot,
}: KillCommandTreeOptions = {}): Promise<void> => {
  const pid = child.pid;
  const killChildOnly = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      void 0;
    }
  };
  if (!isInteger(pid) || pid <= 1) {
    killChildOnly();
    return Promise.resolve();
  }
  if (platform === 'win32') {
    if (!systemRoot) {
      killChildOnly();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const fallBack = () => {
        clearTimeout(bound);
        killChildOnly();
        resolve();
      };
      const bound = setTimeout(fallBack, TASKKILL_WAIT_MS);
      try {
        spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
          .on('error', fallBack)
          .on('exit', (code) => {
            if (code !== 0) return fallBack();
            clearTimeout(bound);
            resolve();
          });
      } catch {
        fallBack();
      }
    });
  }
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    killChildOnly();
  }
  return Promise.resolve();
};

export const stopActiveCommands = async () => {
  admissionClosed = true;
  const kills = [...activeCommands].map(([child, spawn]) => killCommandTree(child, spawn));
  activeCommands.clear();
  await Promise.all(kills);
};

export const runCommandInDirectory = ({ shell, shellFlag, command, resolvedCwd, maxOutputBytes, spawn, execEnv, commandTimeoutMs }: CommandOptions & {
  spawn: typeof nodeSpawn; execEnv: NodeJS.ProcessEnv; commandTimeoutMs: number;
}) => {
  if (admissionClosed) {
    return Promise.resolve<CapturedCommandResult>({
      command,
      success: false,
      exitCode: undefined,
      error: 'Server is shutting down',
      capturedBytes: 0,
    });
  }
  return new Promise<CapturedCommandResult>((resolve) => {
    const output = createExecOutput(maxOutputBytes);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(shell, [shellFlag, command], {
      cwd: resolvedCwd,
      env: execEnv,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeCommands.set(child, spawn);

    const finish = (result: Omit<CapturedCommandResult, keyof ReturnType<typeof output.finish>>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ ...result, ...output.finish() });
    };

    timeout = setTimeout(() => {
      activeCommands.delete(child);
      void killCommandTree(child, spawn);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({
        command,
        success: false,
        exitCode: undefined,
        error: `Command timed out after ${commandTimeoutMs}ms`,
      });
    }, commandTimeoutMs);

    child.stdout?.on('data', output.stdout);
    child.stderr?.on('data', output.stderr);

    child.on('error', (error) => {
      activeCommands.delete(child);
      finish({
        command,
        success: false,
        exitCode: undefined,
        error: (error && error.message) || 'Command execution failed',
      });
    });

    child.on('close', (code) => {
      activeCommands.delete(child);
      const exitCode = code === null ? undefined : code;
      finish({
        command,
        success: exitCode === 0,
        exitCode,
      });
    });
  });
};
