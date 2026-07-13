import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearUpdateMaintenance,
  getUpdateMaintenancePath,
  reserveUpdateMaintenance,
} from './maintenance.js';

const HELPER_READY_TIMEOUT_MS = 5000;
const TRANSACTION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function transactionDirectory(openchamberDataDir, transactionId) {
  return path.join(openchamberDataDir, 'updates', transactionId);
}

function removeOneShotRequest(requestPath) {
  try {
    fs.unlinkSync(requestPath);
  } catch {
  }
}

function writeStartupFailure(statusPath, transaction, error) {
  writePrivateJson(statusPath, {
    id: transaction.id,
    state: 'failed',
    currentVersion: transaction.currentVersion,
    targetVersion: transaction.targetVersion,
    packageManager: transaction.packageManager,
    errorCode: 'helper-start-failed',
    error: error instanceof Error ? error.message : 'Update helper failed to start',
    createdAt: transaction.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

export function buildUpdateHelperLaunchSpec(options) {
  const { id, helperManager, helperRuntime, helperPath, requestPath } = options;
  if (helperManager === 'systemd') {
    return {
      command: 'systemd-run',
      args: [
        '--user',
        '--collect',
        '--quiet',
        '--unit',
        `openchamber-update-${id}`,
        helperRuntime,
        helperPath,
        requestPath,
      ],
    };
  }
  if (helperManager === 'launchd') {
    return {
      command: '/bin/launchctl',
      args: [
        'submit',
        '-l',
        `dev.openchamber.update.${id}`,
        '--',
        helperRuntime,
        helperPath,
        requestPath,
      ],
    };
  }
  return { command: helperRuntime, args: [helperPath, requestPath] };
}

export function readUpdateTransactionStatus(openchamberDataDir, transactionId) {
  if (!TRANSACTION_ID_PATTERN.test(transactionId || '')) return null;
  try {
    const statusPath = path.join(transactionDirectory(openchamberDataDir, transactionId), 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (!status || status.id !== transactionId) return null;
    return status;
  } catch {
    return null;
  }
}

export async function startUpdateTransaction(options) {
  const {
    openchamberDataDir,
    currentVersion,
    targetVersion,
    packageManager,
    packagePath,
    install,
    rollback,
    stop,
    restart,
    oldPid = process.pid,
    helperRuntime = process.execPath,
    helperManager = null,
    spawnChild,
  } = options;

  const id = crypto.randomUUID();
  const directory = transactionDirectory(openchamberDataDir, id);
  const requestPath = path.join(directory, 'request.json');
  const statusPath = path.join(directory, 'status.json');
  const logPath = path.join(directory, 'update.log');
  const markerPath = getUpdateMaintenancePath(openchamberDataDir);
  const helperSourcePath = fileURLToPath(new URL('./helper.mjs', import.meta.url));
  const helperPath = path.join(directory, 'helper.mjs');
  const preparedAt = new Date().toISOString();

  reserveUpdateMaintenance({
    openchamberDataDir,
    marker: {
      id,
      ownerPid: process.pid,
      requestPath,
      statusPath,
      createdAt: preparedAt,
    },
  });

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.copyFileSync(helperSourcePath, helperPath);
    writePrivateJson(statusPath, {
      id,
      state: 'prepared',
      currentVersion,
      targetVersion,
      packageManager,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    writePrivateJson(requestPath, {
      id,
      statusPath,
      markerPath,
      currentVersion,
      targetVersion,
      packageManager,
      packagePath,
      oldPid,
      environment: process.env,
      logPath,
      install,
      rollback,
      stop,
      restart: {
        ...restart,
        env: {
          ...(restart.env || {}),
          OPENCHAMBER_UPDATE_TRANSACTION_ID: id,
        },
      },
    });
  } catch (error) {
    removeOneShotRequest(requestPath);
    clearUpdateMaintenance({ openchamberDataDir, transactionId: id });
    throw error;
  }

  const helperLaunchSpec = buildUpdateHelperLaunchSpec({
    id,
    helperManager,
    helperRuntime,
    helperPath,
    requestPath,
  });

  const logFd = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawnChild(helperLaunchSpec.command, helperLaunchSpec.args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } catch (error) {
    removeOneShotRequest(requestPath);
    writeStartupFailure(statusPath, {
      id,
      currentVersion,
      targetVersion,
      packageManager,
      createdAt: preparedAt,
    }, error);
    clearUpdateMaintenance({ openchamberDataDir, transactionId: id });
    throw error;
  } finally {
    fs.closeSync(logFd);
  }

  const startupError = await new Promise((resolve) => {
    const onError = (error) => resolve(error);
    child.once('error', onError);
    child.once('spawn', () => {
      child.off('error', onError);
      resolve(null);
    });
  });
  if (startupError) {
    removeOneShotRequest(requestPath);
    writeStartupFailure(statusPath, {
      id,
      currentVersion,
      targetVersion,
      packageManager,
      createdAt: preparedAt,
    }, startupError);
    clearUpdateMaintenance({ openchamberDataDir, transactionId: id });
    throw startupError;
  }

  const deadline = Date.now() + HELPER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = readUpdateTransactionStatus(openchamberDataDir, id);
    if (status?.state === 'waiting-for-server-exit' && Number.isInteger(status.helperPid)) {
      child.unref();
      return {
        id,
        currentVersion,
        targetVersion,
        packageManager,
        statusPath,
        logPath,
        helperPid: status.helperPid,
      };
    }
    if (status?.state === 'failed') {
      throw new Error(status.error || 'Update helper failed during startup');
    }
    await sleep(50);
  }

  try {
    child.kill();
  } catch {
  }
  const timeoutError = new Error('Update helper did not report ready before timeout');
  removeOneShotRequest(requestPath);
  writeStartupFailure(statusPath, {
    id,
    currentVersion,
    targetVersion,
    packageManager,
    createdAt: preparedAt,
  }, timeoutError);
  clearUpdateMaintenance({ openchamberDataDir, transactionId: id });
  throw timeoutError;
}
