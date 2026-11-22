import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getRunDir } from './cli-paths.js';
import { readBoundedFileSync } from '../../server/lib/shared/bounded-file-read.js';

// A pid file is a handful of digits (the token-file precedent in
// cli-tunnel-profiles.js caps at 8 KiB); an instance file is a small JSON
// document. Both read through the shared bounded reader (#1706): a FIFO at
// either path is refused promptly instead of hanging the CLI, and an
// over-cap file yields the caller's null default, never a whole-file parse.
const MAX_PID_FILE_BYTES = 8 * 1024;
const MAX_INSTANCE_OPTIONS_BYTES = 1024 * 1024;

function readBoundedTextSync(filePath: string, maxBytes: number) {
  const result = readBoundedFileSync(filePath, maxBytes);
  if (!result.ok) {
    return undefined;
  }
  return result.buffer.toString('utf8');
}
import type { JsonValue } from '../../server/lib/shared/json-values.js';

export interface CliNotice {
  level?: string;
  code?: string;
  message: string;
}

export type InstanceFileFields = {
  port?: JsonValue;
  host?: JsonValue;
  launchMode?: JsonValue;
  uiPassword?: JsonValue;
  hasUiPassword?: JsonValue;
  apiOnly?: JsonValue;
  startedAt?: JsonValue;
  runtime?: JsonValue;
};

export interface InstanceWriteFields {
  port?: unknown;
  host?: unknown;
  launchMode?: unknown;
  uiPassword?: unknown;
  apiOnly?: unknown;
  startedAt?: unknown;
  version?: string | undefined;
  entry?: string | undefined;
  handoffProtocol?: number | undefined;
}

export interface ProcessStateOptions {
  isProcessRunning?: (pid: number) => boolean;
  readProcessCmdline?: (pid: number) => string | null;
}

export interface ProcessStopOptions {
  // The first signal sent; SIGTERM unless the caller asks for another.
  signal?: NodeJS.Signals;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  shutdownWaitMs?: number;
}

export function hasInstanceFields(value: JsonValue | undefined): value is JsonValue & InstanceFileFields {
  return value !== null && value !== undefined;
}

function hasRuntimeField(value: unknown): value is { runtime?: unknown } {
  return Boolean(value);
}

function isProcessText(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteProcessNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function assertProcessFailure(value: unknown): asserts value is { message?: unknown } {
  if (value === null || value === undefined) {
    if (process.versions.bun) {
      throw new TypeError(`${value} is not an object (evaluating 'error.message')`);
    }
    throw new TypeError(`Cannot read properties of ${value} (reading 'message')`);
  }
}

export const SERVER_SHUTDOWN_GRACE_MS = 30_000;

async function getPidFilePath(port: number) {
  return path.join(getRunDir(), `openchamber-${port}.pid`);
}

async function getInstanceFilePath(port: number | undefined) {
  return path.join(getRunDir(), `openchamber-${port}.json`);
}

function readPidFile(pidFilePath: string) {
  try {
    const content = readBoundedTextSync(pidFilePath, MAX_PID_FILE_BYTES)?.trim() ?? "";
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pidFilePath: string, pid: number | undefined, onNotice?: (notice: CliNotice) => void) {
  try {
    fs.writeFileSync(pidFilePath, String(pid), { mode: 0o600 });
  } catch (error) {
    assertProcessFailure(error);
    const message = `Could not write PID file: ${error.message}`;
    if (onNotice !== undefined) {
      onNotice({ level: 'warning', code: 'PID_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removePidFile(pidFilePath: string) {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch {
    void 0;
  }
}

function readInstanceOptions(instanceFilePath: string): JsonValue {
  try {
    const raw = readBoundedTextSync(instanceFilePath, MAX_INSTANCE_OPTIONS_BYTES);
    return raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeInstanceOptions(instanceFilePath: string, options: InstanceWriteFields, onNotice?: (notice: CliNotice) => void) {
  try {
    const toStore = {
      port: options.port,
      host: isProcessText(options.host) && options.host.length > 0 ? options.host : undefined,
      launchMode: options.launchMode === 'foreground' ? 'foreground' : 'daemon',
      uiPassword: isProcessText(options.uiPassword) ? options.uiPassword : undefined,
      hasUiPassword: isProcessText(options.uiPassword),
      apiOnly: options.apiOnly === true,
      startedAt: Number.isFinite(options.startedAt) ? options.startedAt : Date.now(),
      // What is running, so `openchamber handoff` and `status` can read it back: the
      // install entry and version this process serves, and the handoff protocol it
      // speaks. A file without handoffProtocol names a pre-protocol-2 instance.
      version: options.version ? options.version : undefined,
      entry: options.entry ? options.entry : undefined,
      handoffProtocol: Number.isInteger(options.handoffProtocol) ? options.handoffProtocol : undefined,
    };
    fs.writeFileSync(instanceFilePath, JSON.stringify(toStore, null, 2), { mode: 0o600 });
  } catch (error) {
    assertProcessFailure(error);
    const message = `Could not write instance file: ${error.message}`;
    if (onNotice !== undefined) {
      onNotice({ level: 'warning', code: 'INSTANCE_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removeInstanceFile(instanceFilePath: string) {
  try {
    if (fs.existsSync(instanceFilePath)) {
      fs.unlinkSync(instanceFilePath);
    }
  } catch {
    void 0;
  }
}

function isProcessRunning(pid: number | null | undefined) {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCmdline(pid: number) {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const out = (result.stdout || '').trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isOpenchamberCmdline(cmdline: string | null) {
  if (!isProcessText(cmdline) || cmdline.length === 0) {
    return false;
  }
  return cmdline.toLowerCase().includes('openchamber');
}

function isOpenchamberProcessRunning(pid: number) {
  const state = getOpenchamberProcessState(pid);
  return state === 'matched' || state === 'unknown';
}

function getOpenchamberProcessState(pid: number, options: ProcessStateOptions = {}) {
  const checkProcessRunning = options.isProcessRunning !== undefined
    ? options.isProcessRunning
    : isProcessRunning;
  if (!Number.isFinite(pid) || pid <= 0 || !checkProcessRunning(pid)) {
    return 'dead';
  }

  const readCmdline = options.readProcessCmdline !== undefined
    ? options.readProcessCmdline
    : readProcessCmdline;
  const cmdline = readCmdline(pid);
  if (cmdline === null) {
    return 'unknown';
  }
  return isOpenchamberCmdline(cmdline) ? 'matched' : 'mismatched';
}

function hasOpenchamberRuntimeInfo(info: unknown): info is { runtime: string } {
  return hasRuntimeField(info) && isProcessText(info.runtime) && info.runtime.length > 0;
}

function waitForProcessExit(pid: number | null | undefined, timeoutMs: number) {
  if (!isFiniteProcessNumber(pid) || pid <= 0) {
    return Promise.resolve(true);
  }

  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (!isProcessRunning(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

async function terminateProcessTree(pid: number | null | undefined, options: ProcessStopOptions = {}) {
  if (!isFiniteProcessNumber(pid) || pid <= 0) {
    return true;
  }

  const gracefulTimeoutMs = isFiniteProcessNumber(options.gracefulTimeoutMs) && options.gracefulTimeoutMs >= 0
    ? Math.trunc(options.gracefulTimeoutMs)
    : 2500;
  const forceTimeoutMs = isFiniteProcessNumber(options.forceTimeoutMs) && options.forceTimeoutMs >= 0
    ? Math.trunc(options.forceTimeoutMs)
    : 3000;

  if (process.platform === 'win32') {
    try {
      process.kill(pid);
    } catch {
      void 0;
    }

    if (await waitForProcessExit(pid, 800)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
      void 0;
    }

    if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      void 0;
    }

    return waitForProcessExit(pid, forceTimeoutMs);
  }

  try {
    process.kill(pid, options.signal ?? 'SIGTERM');
  } catch {
    void 0;
  }

  if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
    return true;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    void 0;
  }

  return waitForProcessExit(pid, forceTimeoutMs);
}

async function stopInstanceProcess(pid: number | null | undefined, options: ProcessStopOptions = {}) {
  if (!isFiniteProcessNumber(pid) || pid <= 0) {
    return true;
  }

  const shutdownWaitMs = isFiniteProcessNumber(options.shutdownWaitMs) && options.shutdownWaitMs >= 0
    ? Math.trunc(options.shutdownWaitMs)
    : SERVER_SHUTDOWN_GRACE_MS;

  if (await waitForProcessExit(pid, shutdownWaitMs)) {
    return true;
  }

  return terminateProcessTree(pid, options);
}


export {
  getPidFilePath,
  getInstanceFilePath,
  readPidFile,
  writePidFile,
  removePidFile,
  readInstanceOptions,
  writeInstanceOptions,
  removeInstanceFile,
  isProcessRunning,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  getOpenchamberProcessState,
  hasOpenchamberRuntimeInfo,
  terminateProcessTree,
  stopInstanceProcess,
};
