import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandOptions, CommandResult } from './command-contracts.js';

import { SpaceError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_WAIT_MS = 5_000;

const liveTrees = new Set<ChildProcess>();
let exitHandlerInstalled = false;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  systemRoot?: string;
}

export interface KillLiveTreesOptions extends KillTreeOptions {
  children?: Iterable<Pick<ChildProcess, 'pid'>>;
  spawnSyncProcess?: typeof spawnSync;
}

export interface KillProcessTreeOptions extends KillTreeOptions {
  spawnProcess?: typeof spawn;
  waitMs?: number;
}

interface ErrorFile {
  folder: string;
  fd: number;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const hasErrorFields = (value: unknown): value is { message?: unknown; code?: unknown } => value != null;
const errorField = <Cause>(error: Cause, key: 'message' | 'code') => {
  if (!hasErrorFields(error)) throw new TypeError(`Cannot read properties of ${error} (reading '${key}')`);
  return error[key];
};
const firstChunk = (chunks: Buffer[]) => {
  const chunk = chunks[0];
  if (chunk === undefined) throw new TypeError("Cannot read properties of undefined (reading 'length')");
  return chunk;
};

export const liveTreeCount = () => liveTrees.size;

export function killLiveTrees({
  children = liveTrees,
  platform = process.platform,
  kill = (pid, signal) => process.kill(pid, signal),
  spawnSyncProcess = spawnSync,
  systemRoot = process.env.SystemRoot,
}: KillLiveTreesOptions = {}) {
  for (const child of children) {
    const pid = child?.pid;
    if (!isInteger(pid) || pid <= 1) continue;
    try {
      if (platform === 'win32') {
        if (systemRoot) {
          spawnSyncProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
            shell: false, windowsHide: true, stdio: 'ignore', timeout: KILL_WAIT_MS,
          });
        }
      } else {
        kill(-pid, 'SIGKILL');
      }
    } catch {
      continue;
    }
  }
  if (children === liveTrees) liveTrees.clear();
}

const killLiveTreesAtExit = () => killLiveTrees();

const trackTree = (child: ChildProcess) => {
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.prependListener('exit', killLiveTreesAtExit);
  }
  liveTrees.add(child);
};

const abortReason = (signal: AbortSignal, file: string, args: string[]) => (signal.reason instanceof SpaceError
  ? signal.reason
  : new SpaceError('command_aborted', `${file} ${args[0] ?? ''} was stopped by its caller`));

export function runCommand(file: string, args: string[], options: CommandOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const keepTail = options.keepTail === true;
  const stdin = options.stdin ?? '';
  const killTree = options.killTree === true;
  const keepAtExit = options.keepAtExit === true;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  const abortSignal = options.signal;

  return new Promise<CommandResult>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortReason(abortSignal, file, args));
      return;
    }
    let errorFile: ErrorFile | null = null;
    const closeErrorFile = () => {
      if (errorFile === null) return;
      try { fs.closeSync(errorFile.fd); } catch { void 0; }
      fs.rmSync(errorFile.folder, { recursive: true, force: true });
      errorFile = null;
    };
    if (keepAtExit) {
      try {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-stderr-'));
        errorFile = { folder, fd: fs.openSync(path.join(folder, 'stderr'), 'w+') };
      } catch (error) {
        reject(new SpaceError('command_spawn_failed', `Could not start ${file}: no file for its output: ${errorField(error, 'message')}`, { errno: errorField(error, 'code') ?? null }));
        return;
      }
    }
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
        detached: killTree && process.platform !== 'win32',
        stdio: errorFile === null ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', errorFile.fd],
      });
    } catch (error) {
      closeErrorFile();
      reject(new SpaceError('command_spawn_failed', `Could not start ${file}: ${errorField(error, 'message')}`, { errno: errorField(error, 'code') ?? null }));
      return;
    }

    if (killTree && !keepAtExit) trackTree(child);
    if (errorFile !== null) fs.rmSync(errorFile.folder, { recursive: true, force: true });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    const heldBytes = new Map([[stdoutChunks, 0], [stderrChunks, 0]]);
    let settled = false;
    let closed = false;
    const closeWaiters: (() => void)[] = [];
    const waitForClose = () => new Promise<void>((resolveWait) => {
      if (closed) {
        resolveWait();
        return;
      }
      const bound = setTimeout(resolveWait, killWaitMs);
      closeWaiters.push(() => { clearTimeout(bound); resolveWait(); });
    });

    const fail = (error: SpaceError<unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', stop);
      if (!killTree) {
        child.kill('SIGKILL');
        reject(error);
        return;
      }
      killProcessTree(child, { waitMs: killWaitMs }).then(waitForClose).then(() => reject(error));
    };

    const timer = setTimeout(() => {
      fail(new SpaceError('command_timeout', `${file} ${args[0] ?? ''} did not finish within ${timeoutMs} ms and was stopped`));
    }, timeoutMs);
    const stop = () => {
      if (abortSignal) fail(abortReason(abortSignal, file, args));
    };
    abortSignal?.addEventListener('abort', stop, { once: true });

    const window = (chunks: Buffer[]) => (chunk: Buffer) => {
      chunks.push(chunk);
      const previous = heldBytes.get(chunks);
      if (previous === undefined) throw new TypeError('Missing output buffer byte count');
      let held = previous + chunk.length;
      while (held - firstChunk(chunks).length >= maxOutputBytes) {
        const removed = chunks.shift();
        if (removed === undefined) throw new TypeError("Cannot read properties of undefined (reading 'length')");
        held -= removed.length;
      }
      if (held > maxOutputBytes) {
        chunks[0] = firstChunk(chunks).subarray(held - maxOutputBytes);
        held = maxOutputBytes;
      }
      heldBytes.set(chunks, held);
    };
    const capture = (chunks: Buffer[]) => (keepTail ? window(chunks) : (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes) {
        fail(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes and was stopped`));
        return;
      }
      chunks.push(chunk);
    });

    child.stdout?.on('data', capture(stdoutChunks));
    child.stderr?.on('data', capture(stderrChunks));
    const readErrorFile = (errorFile: ErrorFile) => {
      const size = fs.fstatSync(errorFile.fd).size;
      const kept = Buffer.alloc(Math.min(size, maxOutputBytes));
      fs.readSync(errorFile.fd, kept, 0, kept.length, size - kept.length);
      return { size, kept };
    };

    child.on('error', (error) => {
      liveTrees.delete(child);
      closeErrorFile();
      fail(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: errorField(error, 'code') ?? null }));
    });

    child.on('exit', () => {
      liveTrees.delete(child);
    });

    child.on('close', (code, signal) => {
      closed = true;
      for (const wake of closeWaiters.splice(0)) wake();
      if (settled) {
        closeErrorFile();
        return;
      }
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', stop);
      if (code === null) {
        closeErrorFile();
        reject(new SpaceError('command_killed', `${file} ${args[0] ?? ''} was stopped by signal ${signal}`));
        return;
      }
      if (errorFile !== null) {
        let read;
        try {
          read = readErrorFile(errorFile);
        } catch (error) {
          reject(new SpaceError('command_output_unreadable', `The output of ${file} ${args[0] ?? ''} could not be read back: ${errorField(error, 'message')}`, { exitCode: code }));
          return;
        } finally {
          closeErrorFile();
        }
        if (!keepTail && read.size > maxOutputBytes) {
          reject(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes`));
          return;
        }
        stderrChunks.push(read.kept);
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    const input = child.stdin;
    if (input === null) throw new TypeError("Cannot read properties of null (reading 'on')");
    input.on('error', () => {});
    input.end(stdin);
  });
}

export async function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, {
  platform = process.platform,
  kill = (pid, signal) => process.kill(pid, signal),
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot,
  waitMs = KILL_WAIT_MS,
}: KillProcessTreeOptions = {}) {
  const pid = child?.pid;
  if (!isInteger(pid) || pid <= 1) {
    return false;
  }
  const killChildOnly = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
  };
  if (platform === 'win32') {
    if (!systemRoot) {
      killChildOnly();
      return true;
    }
    await new Promise<void>((resolveKill) => {
      const bound = setTimeout(resolveKill, waitMs);
      const done = () => { clearTimeout(bound); resolveKill(); };
      try {
        const killer = spawnProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', () => { killChildOnly(); done(); });
        killer.once('exit', done);
      } catch {
        killChildOnly();
        done();
      }
    });
    return true;
  }
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    killChildOnly();
  }
  return true;
}

const STREAM_STDERR_BYTES = 4 * 1024;

export interface CommandStreamOptions {
  env?: NodeJS.ProcessEnv;
  exitGraceMs?: number;
  onExit?: (exit: { clean: boolean }) => void;
}

export class CommandStream extends Duplex {
  #child: ChildProcessWithoutNullStreams;
  #file: string;
  #args: string[];
  #stderr: Buffer[] = [];
  #stderrBytes = 0;
  #receivedBytes = 0;
  #closed = false;
  #exitGraceMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  timeout: number;

  constructor(child: ChildProcessWithoutNullStreams, file: string, args: string[], { exitGraceMs = 0, onExit }: CommandStreamOptions = {}) {
    super({ allowHalfOpen: false });
    this.#child = child;
    this.#file = file;
    this.#args = args;
    this.#exitGraceMs = exitGraceMs;
    this.timeout = 0;
    this.on('error', () => {});

    child.stdout.on('data', (chunk: Buffer) => {
      this.#receivedBytes += chunk.length;
      this.#touch();
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.#stderrBytes >= STREAM_STDERR_BYTES) return;
      this.#stderr.push(chunk.subarray(0, STREAM_STDERR_BYTES - this.#stderrBytes));
      this.#stderrBytes += chunk.length;
    });
    child.stdin.on('error', (error) => {
      if (!this.#closed) this.destroy(this.#failure(`its input closed: ${errorField(error, 'code') ?? error.message}`));
    });
    child.on('error', (error) => {
      this.#closed = true;
      this.destroy(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: errorField(error, 'code') ?? null }));
    });
    child.on('close', (code, signal) => {
      this.#closed = true;
      onExit?.({ clean: code === 0 });
      if (this.destroyed) return;
      if (code === 0 && this.#receivedBytes > 0) {
        this.push(null);
        return;
      }
      const why = code === null ? `stopped by signal ${signal}` : `exited with code ${code}`;
      this.destroy(this.#failure(`${why}${this.#stderrText() ? `: ${this.#stderrText()}` : ''}`));
    });
  }

  #stderrText() {
    return Buffer.concat(this.#stderr).toString('utf8').trim();
  }

  #failure(what: string) {
    return new SpaceError('command_stream_failed', `${this.#file} ${this.#args[0] ?? ''} ${what}`);
  }

  #touch() {
    if (this.timeout > 0) this.setTimeout(this.timeout);
  }

  override _read() {
    this.#child.stdout.resume();
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.#touch();
    if (this.#closed) {
      callback(this.#failure('has ended'));
      return;
    }
    this.#child.stdin.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.#closed) {
      callback();
      return;
    }
    this.#child.stdin.end(callback);
  }

  #kill() {
    if (this.#closed) return;
    try {
      this.#child.kill('SIGKILL');
    } catch {
      void 0;
    }
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#child.stdout.removeAllListeners('data');
    if (this.#exitGraceMs === 0 || this.#closed) {
      this.#kill();
    } else {
      this.#child.stdout.resume();
      this.#child.stdin.end();
      const timer = setTimeout(() => this.#kill(), this.#exitGraceMs);
      timer.unref();
      this.#child.once('close', () => clearTimeout(timer));
    }
    callback(error);
  }

  setTimeout(milliseconds: number, callback?: () => void) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.timeout = milliseconds;
    if (callback) {
      if (milliseconds > 0) this.once('timeout', callback);
      else this.removeListener('timeout', callback);
    }
    if (milliseconds > 0) {
      this.#timer = setTimeout(() => { this.#timer = null; this.emit('timeout'); }, milliseconds);
      this.#timer.unref?.();
    }
    return this;
  }

  setNoDelay() { return this; }

  setKeepAlive() { return this; }

  ref() { return this; }

  unref() { return this; }
}

export function openCommandStream(file: string, args: string[], options: CommandStreamOptions = {}) {
  let child;
  try {
    child = spawn(file, args, { shell: false, windowsHide: true, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new SpaceError('command_spawn_failed', `Could not start ${file}: ${errorField(error, 'message')}`, { errno: errorField(error, 'code') ?? null });
  }
  return new CommandStream(child, file, args, options);
}
