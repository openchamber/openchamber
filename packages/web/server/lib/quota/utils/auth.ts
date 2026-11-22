import os from 'os';
import path from 'path';
import { getOpenCodeDataDir, OPENCODE_CONFIG_DIR } from '../../opencode/config-files.js';
import { isString } from '../../shared/object-guards.js';
import { readBoundedFileSync } from '../../shared/bounded-file-read.js';
import { asNonEmptyString } from './transformers.js';
import type { JsonValue } from './contracts.js';

// The JSON files readJsonFile loads are credential documents: a Claude Code
// credentials file, an Antigravity accounts file (several accounts, each a
// small token set). 1 MiB is generous headroom for those shapes - the GitHub
// auth file precedent - and anything past it is not a credential file: the
// bounded reader refuses it (and any non-regular file, e.g. a FIFO,
// promptly) instead of buffering it whole through a synchronous read that
// would block the whole server (#1645).
const QUOTA_JSON_FILE_MAX_BYTES = 1 * 1024 * 1024;

// A {file:} apiKey target holds one API key - a short string. 64 KiB is
// generous headroom for that shape, the quota credential store precedent
// (#1613); an over-cap or non-regular target degrades exactly like an
// unreadable one does today: null (#1645).
const CONFIG_API_KEY_FILE_MAX_BYTES = 64 * 1024;

export interface ConfigApiKeyOptions {
  configDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(getOpenCodeDataDir(), 'antigravity-accounts.json')
];

const isObjectEntry = (value: unknown): value is object => typeof value === 'object';

export const readJsonFile = (filePath: string): JsonValue | null => {
  try {
    const result = readBoundedFileSync(filePath, QUOTA_JSON_FILE_MAX_BYTES);
    if (!result.ok) {
      if (result.reason !== 'missing') {
        console.warn(`Failed to read JSON file: ${filePath}`, result.code);
      }
      return null;
    }
    const trimmed = result.buffer.toString('utf8').trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = <Entry>(auth: Readonly<Record<string, Entry>>, aliases: readonly string[]) => {
  for (const alias of aliases) {
    const entry = auth[alias];
    if (entry) {
      return entry;
    }
  }
  return null;
};

export const normalizeAuthEntry = <Entry>(entry: Entry): object | null => {
  if (!entry) return null;
  if (isString(entry)) {
    return { token: entry };
  }
  if (isObjectEntry(entry)) {
    return entry;
  }
  return null;
};

const CONFIG_FILE_REFERENCE = /^\{file:(.+)\}$/i;
const CONFIG_ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const resolveConfigApiKey = <Value>(value: Value, { configDir = OPENCODE_CONFIG_DIR, homeDir = os.homedir(), env = process.env }: ConfigApiKeyOptions = {}) => {
  const trimmed = asNonEmptyString(value);
  if (!trimmed) return null;
  const envName = trimmed.match(CONFIG_ENV_REFERENCE)?.[1];
  if (envName !== undefined) {
    const resolved = env[envName]?.trim();
    return resolved || null;
  }
  const fileTarget = trimmed.match(CONFIG_FILE_REFERENCE)?.[1];
  if (fileTarget === undefined) return trimmed;
  let target = fileTarget.trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(homeDir, target.slice(1));
  else if (!path.isAbsolute(target)) target = path.join(configDir, target);
  try {
    const result = readBoundedFileSync(target, CONFIG_API_KEY_FILE_MAX_BYTES);
    if (!result.ok) return null;
    return result.buffer.toString('utf8').trim() || null;
  } catch {
    return null;
  }
};
