import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR } from '../../opencode/shared.js';
import { asNonEmptyString } from './transformers.js';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json')
];

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

export const normalizeAuthEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};

const CONFIG_FILE_REFERENCE = /^\{file:(.+)\}$/i;
const CONFIG_ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * A provider `options.apiKey` from opencode.json, with OpenCode's own
 * substitutions applied: `{file:path}` (a leading `~/` is the home directory,
 * a relative path the config directory) and `{env:NAME}`. Anything else is the
 * key itself. Null when the reference names nothing readable, so the provider
 * reads as not configured instead of sending the reference as a bearer token.
 */
export const resolveConfigApiKey = (value, { configDir = OPENCODE_CONFIG_DIR, homeDir = os.homedir(), env = process.env } = {}) => {
  const trimmed = asNonEmptyString(value);
  if (!trimmed) return null;
  const envMatch = trimmed.match(CONFIG_ENV_REFERENCE);
  if (envMatch) {
    const resolved = env[envMatch[1]]?.trim();
    return resolved || null;
  }
  const fileMatch = trimmed.match(CONFIG_FILE_REFERENCE);
  if (!fileMatch) return trimmed;
  let target = fileMatch[1].trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(homeDir, target.slice(1));
  else if (!path.isAbsolute(target)) target = path.join(configDir, target);
  try {
    return fs.readFileSync(target, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

