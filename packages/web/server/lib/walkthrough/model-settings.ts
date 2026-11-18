import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { asNonEmptyString } from '../shared/guards.js';

const SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const isModelOverride = (value: unknown): value is string => typeof value === 'string';
const isWalkthroughModelSettings = (value: unknown): value is {
  walkthroughModelOverride?: unknown;
  walkthroughModelVariant?: unknown;
} => value !== null && typeof value === 'object';

export function readWalkthroughModelOverride() {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  if (!isWalkthroughModelSettings(settings)) return null;
  const value = settings.walkthroughModelOverride;
  const override = isModelOverride(value)
    ? value.trim()
    : '';
  return override || null;
}

export function readWalkthroughModelVariant() {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  if (!readWalkthroughModelOverride()) return null;
  if (!isWalkthroughModelSettings(settings)) return null;
  return asNonEmptyString(settings.walkthroughModelVariant);
}
