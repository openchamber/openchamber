import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_EXIT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
let updateLogFd = null;

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function updateStatus(request, state, extra = {}) {
  writeJsonAtomic(request.statusPath, {
    id: request.id,
    state,
    currentVersion: request.currentVersion,
    targetVersion: request.targetVersion,
    packageManager: request.packageManager,
    helperPid: process.pid,
    createdAt: request.createdAt,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + SERVER_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await sleep(100);
  }
  throw Object.assign(new Error('Old OpenChamber process did not exit before timeout'), { code: 'server-exit-timeout' });
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
}

async function terminateProcessTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === 'win32') {
    const script = `
function Stop-ProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $ProcessId) -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
Stop-ProcessTree -ProcessId ${child.pid}
`;
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    const terminator = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedCommand,
    ], {
      windowsHide: true,
      stdio: updateLogFd === null ? 'ignore' : ['ignore', updateLogFd, updateLogFd],
    });
    await waitForChildExit(terminator);
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
  }
  await sleep(2000);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
  }
}

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, terminateTree = false, ...spawnOptions } = options;
    let settled = false;
    let timeoutError = null;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: updateLogFd === null ? 'inherit' : ['ignore', updateLogFd, updateLogFd],
      detached: terminateTree,
      ...spawnOptions,
    });
    const childExit = waitForChildExit(child);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(value);
    };
    child.once('error', (error) => finish(reject, timeoutError || error));
    child.once('exit', (code, signal) => {
      if (timeoutError) {
        finish(reject, timeoutError);
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(reject, Object.assign(
        new Error(`Process exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}`),
        { exitCode: code },
      ));
    });
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(async () => {
          if (settled) return;
          timeoutError = Object.assign(new Error(`Process timed out after ${timeoutMs}ms`), { code: 'process-timeout' });
          try {
            if (terminateTree) {
              await terminateProcessTree(child);
            } else {
              child.kill();
            }
          } catch {
          }
          await Promise.race([childExit, sleep(5000)]);
          finish(reject, timeoutError);
        }, timeoutMs)
      : null;
  });
}

function logUpdate(level, message) {
  const line = `[updater] ${message}\n`;
  if (updateLogFd !== null) {
    try {
      fs.writeSync(updateLogFd, line);
      return;
    } catch {
    }
  }
  console[level](line.trimEnd());
}

function getBaseEnvironment(request) {
  return { ...process.env, ...(request.environment || {}) };
}

function readInstalledVersion(packagePath) {
  const packageJsonPath = path.join(packagePath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return typeof packageJson.version === 'string' ? packageJson.version : null;
}

function readInstalledVersionOrNull(packagePath) {
  try {
    return readInstalledVersion(packagePath);
  } catch {
    return null;
  }
}

async function waitForHealth(healthUrl, targetVersion, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.openchamberVersion === targetVersion) return true;
      }
    } catch {
    }
    await sleep(500);
  }
  return false;
}

function clearMaintenanceMarker(request) {
  try {
    const marker = JSON.parse(fs.readFileSync(request.markerPath, 'utf8'));
    if (marker?.id !== request.id) return;
    fs.rmSync(path.dirname(request.markerPath), { recursive: true, force: true });
  } catch {
  }
}

function markRecoveryRequired(request) {
  writeJsonAtomic(request.markerPath, {
    id: request.id,
    helperPid: process.pid,
    statusPath: request.statusPath,
    requiresRecovery: true,
    recoveryTargetVersion: request.targetVersion,
    createdAt: request.createdAt,
  });
}

export function deleteOneShotRequest(requestPath, fsLike = fs) {
  try {
    fsLike.unlinkSync(requestPath);
    return;
  } catch (unlinkError) {
    try {
      fsLike.writeFileSync(requestPath, '{}\n', { mode: 0o600 });
    } catch (scrubError) {
      throw Object.assign(new Error('Unable to delete or scrub the update request'), {
        code: 'request-delete-failed',
        cause: scrubError,
      });
    }
    throw Object.assign(new Error('Unable to delete the update request'), {
      code: 'request-delete-failed',
      cause: unlinkError,
    });
  }
}

function setReplacementStartAllowed(request, allowed) {
  writeJsonAtomic(request.markerPath, {
    id: request.id,
    helperPid: process.pid,
    statusPath: request.statusPath,
    recoveryTargetVersion: request.targetVersion,
    allowForegroundRestart: allowed && request.restart.mode === 'service',
    createdAt: request.createdAt,
  });
}

async function startReplacement(request, expectedVersion = request.targetVersion) {
  if (request.restart.mode === 'daemon') {
    await spawnAndWait(request.restart.command, request.restart.args, {
      env: { ...getBaseEnvironment(request), ...(request.restart.env || {}) },
    });
    return;
  }
  if (request.restart.serviceCommand) {
    const attempts = request.restart.serviceManager === 'windows-task' ? 10 : 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await spawnAndWait(request.restart.serviceCommand, request.restart.serviceArgs || []);
        if (request.restart.serviceManager === 'windows-task') {
          if (await waitForHealth(request.restart.healthUrl, expectedVersion, 5000)) return;
          lastError = new Error('Scheduled task accepted the restart request but OpenChamber did not become healthy');
          if (attempt + 1 < attempts) await sleep(1000);
          continue;
        }
        return;
      } catch (error) {
        lastError = error;
        if (await waitForHealth(request.restart.healthUrl, expectedVersion, 1000)) return;
        if (attempt + 1 < attempts) await sleep(1000);
      }
    }
    throw lastError || new Error('Service restart request failed');
  }
}

async function attemptRecovery(request, failure) {
  let installedVersion = readInstalledVersionOrNull(request.packagePath);
  setReplacementStartAllowed(request, false);

  if (installedVersion !== request.currentVersion && request.stop) {
    try {
      await spawnAndWait(request.stop.command, request.stop.args || [], {
        env: getBaseEnvironment(request),
      });
    } catch {
    }
  }

  if (installedVersion !== request.currentVersion) {
    if (!request.rollback) return false;
    updateStatus(request, 'rolling-back', {
      errorCode: failure.code || 'update-failed',
      error: failure.message,
      installedVersion,
    });
    try {
      await spawnAndWait(request.rollback.command, request.rollback.args, {
        env: { ...getBaseEnvironment(request), ...(request.rollback.env || {}) },
        timeoutMs: request.rollback.timeoutMs || INSTALL_TIMEOUT_MS,
        terminateTree: true,
      });
      installedVersion = readInstalledVersionOrNull(request.packagePath);
      if (installedVersion !== request.currentVersion) return false;
    } catch {
      return false;
    }
  }

  setReplacementStartAllowed(request, true);
  try {
    await startReplacement(request, request.currentVersion);
    if (await waitForHealth(request.restart.healthUrl, request.currentVersion, 30_000)) {
      clearMaintenanceMarker(request);
      updateStatus(request, 'recovered-old-version', {
        errorCode: failure.code || 'update-failed',
        error: failure.message,
        installedVersion: request.currentVersion,
      });
      return true;
    }
  } catch {
  }
  return false;
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('Missing update request path');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  request.createdAt = new Date().toISOString();
  try {
    deleteOneShotRequest(requestPath);
  } catch (error) {
    updateStatus(request, 'failed', {
      errorCode: error.code || 'request-delete-failed',
      error: error.message,
    });
    clearMaintenanceMarker(request);
    throw error;
  }
  if (typeof request.logPath === 'string') {
    fs.mkdirSync(path.dirname(request.logPath), { recursive: true, mode: 0o700 });
    updateLogFd = fs.openSync(request.logPath, 'a', 0o600);
  }

  writeJsonAtomic(request.markerPath, {
    id: request.id,
    helperPid: process.pid,
    statusPath: request.statusPath,
    recoveryTargetVersion: request.targetVersion,
    createdAt: request.createdAt,
  });
  updateStatus(request, 'waiting-for-server-exit');

  try {
    await waitForProcessExit(Number(request.oldPid));
    updateStatus(request, 'installing');
    try {
      await spawnAndWait(request.install.command, request.install.args, {
        env: { ...getBaseEnvironment(request), ...(request.install.env || {}) },
        timeoutMs: request.install.timeoutMs || INSTALL_TIMEOUT_MS,
        terminateTree: true,
      });
    } catch (error) {
      if (error && !error.code) error.code = 'install-failed';
      throw error;
    }

    updateStatus(request, 'verifying');
    const installedVersion = readInstalledVersion(request.packagePath);
    if (installedVersion !== request.targetVersion) {
      throw Object.assign(
        new Error(`Installed version ${installedVersion || 'unknown'} does not match target ${request.targetVersion}`),
        { code: 'version-mismatch' },
      );
    }

    updateStatus(request, request.restart.mode === 'daemon' ? 'restarting' : 'awaiting-service-restart', {
      installedVersion,
    });
    setReplacementStartAllowed(request, true);
    try {
      await startReplacement(request);
    } catch (error) {
      if (error && !error.code) error.code = 'restart-failed';
      throw error;
    }

    updateStatus(request, 'checking-health', { installedVersion });
    if (!await waitForHealth(request.restart.healthUrl, request.targetVersion)) {
      throw Object.assign(new Error('Updated OpenChamber did not become healthy before timeout'), { code: 'health-timeout' });
    }
    clearMaintenanceMarker(request);
    updateStatus(request, 'healthy', { installedVersion });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    logUpdate('error', failure.message);
    if (await attemptRecovery(request, failure)) return;
    updateStatus(request, 'failed', {
      errorCode: failure.code || 'update-failed',
      error: failure.message,
    });
    markRecoveryRequired(request);
    process.exitCode = 1;
  }
}

const invokedPath = typeof process.argv[1] === 'string' ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isMain = process.platform === 'win32'
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath;

if (isMain) {
  main().catch((error) => {
    logUpdate('error', `fatal startup failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
