import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from '../shared/guards.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import type { SettingsDocument } from './settings-helpers.js';

export const readSettingsFileForUpdateSync = (filePath: string): SettingsDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${path.basename(filePath)}; the change was not saved`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`Could not read ${path.basename(filePath)}; the change was not saved`);
  return parsed;
};
