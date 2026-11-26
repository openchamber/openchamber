import fs from 'fs';
import os from 'os';
import path from 'path';
import { OPENCODE_CONFIG_DIR } from '../../opencode/config-files.js';
import { isString } from '../../shared/object-guards.js';
import { asNonEmptyString } from './transformers.js';
import type { JsonValue } from './contracts.js';

export interface ConfigApiKeyOptions {
  configDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

const isObjectEntry = (value: unknown): value is object => typeof value === 'object';

export const readJsonFile = (filePath: string): JsonValue | null => {
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
    return fs.readFileSync(target, 'utf8').trim() || null;
  } catch {
    return null;
  }
};
