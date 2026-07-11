import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getRunDir } from './cli-paths.js';

async function getPidFilePath(port) {
  return path.join(getRunDir(), `openchamber-${port}.pid`);
}

async function getInstanceFilePath(port) {
  return path.join(getRunDir(), `openchamber-${port}.json`);
}

function readPidFile(pidFilePath) {
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pidFilePath, pid, onNotice) {
  try {
    fs.writeFileSync(pidFilePath, String(pid), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write PID file: ${error.message}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'PID_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removePidFile(pidFilePath) {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch {
  }
}

function readInstanceOptions(instanceFilePath) {
  try {
    return JSON.parse(fs.readFileSync(instanceFilePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeInstanceOptions(instanceFilePath, options, onNotice) {
  try {
    const toStore = {
      port: options.port,
      host: typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined,
      launchMode: options.launchMode === 'foreground' ? 'foreground' : 'daemon',
      uiPassword: typeof options.uiPassword === 'string' ? options.uiPassword : undefined,
      hasUiPassword: typeof options.uiPassword === 'string',
      apiOnly: options.apiOnly === true,
      startedAt: Number.isFinite(options.startedAt) ? options.startedAt : Date.now(),
    };
    fs.writeFileSync(instanceFilePath, JSON.stringify(toStore, null, 2), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write instance file: ${error.message}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'INSTANCE_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removeInstanceFile(instanceFilePath) {
  try {
    if (fs.existsSync(instanceFilePath)) {
      fs.unlinkSync(instanceFilePath);
    }
  } catch {
  }
}

// Liveness only — "is *some* process alive with this PID". Use this when the
// PID is known to be ours (a child we just spawned, or a process we are
// stopping). Do NOT use it to validate a PID read from a pid file: after an
// ungraceful shutdown the pid file is stale and the kernel may have recycled
// that PID to an unrelated process — see isOpenchamberProcessRunning.
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort command line for a live PID, used for identity verification.
// Returns the cmdline string, '' when the process has no readable cmdline, or
// null when identity can't be determined on this platform (caller falls back to
// liveness — so behaviour is unchanged where we can't check).
function readProcessCmdline(pid) {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/cmdline is a NUL-delimited argv list.
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
  // Windows / other: a process's full command line isn't cheaply available, so
  // we can't verify identity — fall back to liveness-only.
  return null;
}

function isOpenchamberCmdline(cmdline) {
  if (typeof cmdline !== 'string' || cmdline.length === 0) {
    return false;
  }
  // Every install path contains the "openchamber" segment — the npm package
  // (@openchamber/web) and the source checkout both do, for the foreground
  // (bin/cli.js) and daemon (server/index.js) entrypoints alike. Matching the
  // path segment (not a generic "cli.js") keeps a recycled stranger such as
  // "npm-cli.js" or "agentmemory" from being mistaken for us.
  return cmdline.toLowerCase().includes('openchamber');
}

// Liveness + identity — "is the OpenChamber instance recorded in a pid file
// still the process running under this PID". Use this (not isProcessRunning)
// when validating a PID read from a pid file. After an ungraceful shutdown
// removePidFile never runs, so the stale PID can be recycled to an unrelated
// process; a liveness-only check then reports us as "already running" and aborts
// startup, which loops forever under systemd Restart=always (issue #1721).
// Where identity can't be determined (Windows, unreadable /proc or ps), we fall
// back to liveness so there are no false negatives on those platforms.
function isOpenchamberProcessRunning(pid) {
  const state = getOpenchamberProcessState(pid);
  return state === 'matched' || state === 'unknown';
}

function getOpenchamberProcessState(pid, options = {}) {
  const checkProcessRunning = typeof options.isProcessRunning === 'function'
    ? options.isProcessRunning
    : isProcessRunning;
  if (!Number.isFinite(pid) || pid <= 0 || !checkProcessRunning(pid)) {
    return 'dead';
  }

  const readCmdline = typeof options.readProcessCmdline === 'function'
    ? options.readProcessCmdline
    : readProcessCmdline;
  const cmdline = readCmdline(pid);
  if (cmdline === null) {
    return 'unknown';
  }
  return isOpenchamberCmdline(cmdline) ? 'matched' : 'mismatched';
}

function hasOpenchamberRuntimeInfo(info) {
  return Boolean(info && typeof info.runtime === 'string' && info.runtime.length > 0);
}

function waitForProcessExit(pid, timeoutMs) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve(true);
  }

  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
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

async function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const gracefulTimeoutMs = Number.isFinite(options.gracefulTimeoutMs) && options.gracefulTimeoutMs >= 0
    ? Math.trunc(options.gracefulTimeoutMs)
    : 2500;
  const forceTimeoutMs = Number.isFinite(options.forceTimeoutMs) && options.forceTimeoutMs >= 0
    ? Math.trunc(options.forceTimeoutMs)
    : 3000;

  if (process.platform === 'win32') {
    try {
      process.kill(pid);
    } catch {
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
    }

    return waitForProcessExit(pid, forceTimeoutMs);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
  }

  if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
    return true;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
  }

  return waitForProcessExit(pid, forceTimeoutMs);
}

async function stopInstanceProcess(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const shutdownWaitMs = Number.isFinite(options.shutdownWaitMs) && options.shutdownWaitMs >= 0
    ? Math.trunc(options.shutdownWaitMs)
    : 5000;

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
