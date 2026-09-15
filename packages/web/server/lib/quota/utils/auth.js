import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR } from '../../opencode/shared.js';

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

// OpenCode config accepts `{file:/path}` apiKey references and resolves them for
// chat traffic; raw references reaching a quota provider mean the key never loads.
export const resolveApiKeyFileReference = (value) => {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(/^\{file:(.+)\}$/);
  if (!match) return value;
  try {
    const resolved = fs.readFileSync(match[1].trim(), 'utf8').trim();
    return resolved || value;
  } catch {
    return value;
  }
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
