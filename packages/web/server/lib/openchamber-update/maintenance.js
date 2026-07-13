import fs from 'node:fs';
import path from 'node:path';

const UPDATE_MAINTENANCE_DIRECTORY = 'openchamber-update.lock';
const UPDATE_MAINTENANCE_FILE = 'marker.json';
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export function getUpdateMaintenancePath(openchamberDataDir) {
  return path.join(openchamberDataDir, 'run', UPDATE_MAINTENANCE_DIRECTORY, UPDATE_MAINTENANCE_FILE);
}

export function shouldDeferStartForUpdate(marker, options = {}) {
  if (!marker) return false;
  if (marker.id && options.transactionId === marker.id) return false;
  if (marker.allowForegroundRestart === true && options.foreground === true) return false;
  return true;
}

function isProcessRunning(pid, processLike) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeOrphanedRequest(marker, openchamberDataDir, fsLike) {
  if (typeof marker?.requestPath !== 'string') return;
  const updatesRoot = path.resolve(openchamberDataDir, 'updates');
  const requestPath = path.resolve(marker.requestPath);
  if (requestPath !== updatesRoot && !requestPath.startsWith(`${updatesRoot}${path.sep}`)) return;
  try {
    fsLike.unlinkSync(requestPath);
  } catch {
  }
}

export function reserveUpdateMaintenance(options = {}) {
  const {
    openchamberDataDir,
    marker,
    fsLike = fs,
    processLike = process,
  } = options;
  const markerPath = getUpdateMaintenancePath(openchamberDataDir);
  const lockDirectory = path.dirname(markerPath);
  const runDirectory = path.dirname(lockDirectory);
  fsLike.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporaryDirectory = path.join(runDirectory, `.${UPDATE_MAINTENANCE_DIRECTORY}-${processLike.pid || process.pid}-${Date.now()}-${attempt}`);
    try {
      fsLike.mkdirSync(temporaryDirectory, { mode: 0o700 });
      fsLike.writeFileSync(path.join(temporaryDirectory, UPDATE_MAINTENANCE_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
      fsLike.renameSync(temporaryDirectory, lockDirectory);
      return markerPath;
    } catch (error) {
      try {
        fsLike.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
      }
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EPERM') throw error;
      if (readActiveUpdateMaintenance({ openchamberDataDir, fsLike, processLike })) {
        const conflict = new Error('Another OpenChamber update is already in progress');
        conflict.statusCode = 409;
        throw conflict;
      }
    }
  }
  throw new Error('Unable to reserve the OpenChamber update maintenance marker');
}

export function clearUpdateMaintenance(options = {}) {
  const { openchamberDataDir, transactionId, fsLike = fs } = options;
  const markerPath = getUpdateMaintenancePath(openchamberDataDir);
  try {
    const marker = JSON.parse(fsLike.readFileSync(markerPath, 'utf8'));
    if (transactionId && marker?.id !== transactionId) return;
    fsLike.rmSync(path.dirname(markerPath), { recursive: true, force: true });
  } catch {
  }
}

export function readActiveUpdateMaintenance(options = {}) {
  const {
    openchamberDataDir,
    fsLike = fs,
    processLike = process,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  } = options;
  const markerPath = getUpdateMaintenancePath(openchamberDataDir);

  try {
    const marker = JSON.parse(fsLike.readFileSync(markerPath, 'utf8'));
    const createdAt = Date.parse(marker?.createdAt || '');
    const fresh = Number.isFinite(createdAt) && Date.now() - createdAt <= maxAgeMs;
    const ownerPid = Number(marker?.helperPid || marker?.ownerPid);
    if (fresh && isProcessRunning(ownerPid, processLike)) {
      return marker;
    }
    removeOrphanedRequest(marker, openchamberDataDir, fsLike);
  } catch {
  }

  try {
    fsLike.rmSync(path.dirname(markerPath), { recursive: true, force: true });
  } catch {
  }
  return null;
}
