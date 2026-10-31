import fs from 'fs';
import os from 'os';
import path from 'path';
import { isBoolean, isPlainObject } from '../shared/guards.js';

/**
 * The local tracker's preferences, stored in the OpenChamber data dir as
 * `local-tracker.json`. The `resolveDataDir` and tmp+rename write pattern are
 * copied from `../linear/auth.js` rather than imported: the local module owns
 * its storage file and shares no state with the Linear one.
 */

const DEFAULT_PREFERENCES = { sessionComments: true };

function readEnv(name) {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}

function resolveDataDir() {
  const fromEnv = readEnv('OPENCHAMBER_DATA_DIR');
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function storageFile() {
  return path.join(resolveDataDir(), 'local-tracker.json');
}

function ensureStorageDir() {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read local tracker preferences file:', error);
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureStorageDir();
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

// Session comments default to on for a local tracker (the comments land in the
// user's own files, unlike Linear's shared workspace), so a value that is not
// a boolean — an older or hand-edited file — falls back to the default rather
// than silently disabling the feature.
function normalizePreferences(value) {
  if (!isPlainObject(value)) {
    return { ...DEFAULT_PREFERENCES };
  }
  return { sessionComments: isBoolean(value.sessionComments) ? value.sessionComments : true };
}

export function readLocalPreferences() {
  return normalizePreferences(readJsonFile(storageFile()));
}

export function writeLocalPreferences(input) {
  const next = normalizePreferences(input);
  writeJsonFile(storageFile(), next);
  return next;
}
