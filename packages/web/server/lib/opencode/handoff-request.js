import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { asNonEmptyString, isBoolean, isRecord, isString } from '../shared/guards.js';

const REQUEST_FILE_NAME = 'handoff-request.json';
const REQUEST_MAX_AGE_MS = 60_000;
const REQUEST_MAX_BYTES = 16 * 1024;

const processIsRunning = (pid, kill = process.kill) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

export const getHandoffRequestPath = (dataDir) => path.join(dataDir, 'run', REQUEST_FILE_NAME);

export const writeHandoffRequest = ({ dataDir, requesterPid = process.pid, entry, execPath = process.execPath, version, allowDowngrade = false, now = Date.now }) => {
  const request = { requesterPid, entry, execPath, version, requestedAt: now(), allowDowngrade };
  const filePath = getHandoffRequestPath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
  return request;
};

// Consume before validating: one stale or malformed request must not poison a later signal.
export const consumeHandoffRequest = ({ dataDir, now = Date.now, kill = process.kill }) => {
  const filePath = getHandoffRequestPath(dataDir);
  // Claim the observed request by atomically renaming it to a private path
  // before reading it. The CLI writer publishes by atomically replacing
  // filePath, so a request that lands there after this claim is a different
  // file: it must survive this consume, and only the claimed file is ever
  // unlinked here. A second consumer loses the rename race and sees no
  // request, preserving single-consumer behavior.
  const claimPath = `${filePath}.consuming-${randomUUID()}`;
  try {
    fs.renameSync(filePath, claimPath);
  } catch {
    return null;
  }
  let bytes;
  try {
    const stat = fs.lstatSync(claimPath);
    if (!stat.isFile()) {
      // Not a request file: put it back if the request path is still free
      // rather than destroying something this consume did not observe.
      try { if (!fs.existsSync(filePath)) fs.renameSync(claimPath, filePath); } catch {}
      return null;
    }
    if (stat.size > REQUEST_MAX_BYTES) return null;
    bytes = fs.readFileSync(claimPath);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(claimPath); } catch {}
  }
  try {
    const request = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(request)
      || !Number.isSafeInteger(request.requesterPid) || request.requesterPid <= 0
      || !Number.isSafeInteger(request.requestedAt) || now() - request.requestedAt < 0 || now() - request.requestedAt >= REQUEST_MAX_AGE_MS
      || !asNonEmptyString(request.entry)
      || !asNonEmptyString(request.execPath)
      || !asNonEmptyString(request.version)
      || (request.allowDowngrade !== undefined && !isBoolean(request.allowDowngrade))
      || !processIsRunning(request.requesterPid, kill)) return null;
    return { ...request, allowDowngrade: request.allowDowngrade === true };
  } catch {
    return null;
  }
};

const parseVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] };
};

export const compareHandoffVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

const readInstalledPackage = (entry, realpath = fs.realpathSync, stat = fs.statSync, readFile = fs.readFileSync) => {
  try {
    const canonicalEntry = realpath(entry);
    if (!stat(canonicalEntry).isFile()) return null;
    const packagePath = path.resolve(path.dirname(canonicalEntry), '..', 'package.json');
    const pkg = JSON.parse(readFile(packagePath, 'utf8'));
    if (!isRecord(pkg) || pkg.name !== '@openchamber/web' || !isString(pkg.version) || !parseVersion(pkg.version)) return null;
    return { entry: canonicalEntry, version: pkg.version };
  } catch {
    return null;
  }
};

export const resolveHandoffTarget = ({ request, env = process.env, entry, execPath = process.execPath, runningVersion, exists = fs.existsSync, realpath = fs.realpathSync, stat = fs.statSync, readFile = fs.readFileSync }) => {
  let candidate;
  if (request) candidate = { entry: request.entry, execPath: request.execPath, version: request.version, allowDowngrade: request.allowDowngrade };
  else if (asNonEmptyString(env.OPENCHAMBER_HANDOFF_ENTRY)) candidate = { entry: asNonEmptyString(env.OPENCHAMBER_HANDOFF_ENTRY), execPath, allowDowngrade: false };
  else candidate = { entry, execPath, allowDowngrade: false };

  const installed = readInstalledPackage(candidate.entry, realpath, stat, readFile);
  if (!installed || (candidate.version && candidate.version !== installed.version)) return { ok: false, reason: 'entry-invalid' };
  if (!exists(candidate.execPath)) return { ok: false, reason: 'entry-invalid' };
  if (compareHandoffVersions(installed.version, runningVersion) === null
    || (compareHandoffVersions(installed.version, runningVersion) < 0 && candidate.allowDowngrade !== true)) {
    return { ok: false, reason: 'downgrade-refused' };
  }
  return { ok: true, entry: installed.entry, execPath: candidate.execPath, version: installed.version };
};
