import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { asNonEmptyString } from '../shared/guards.js';

const SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

export function readWalkthroughModelOverride() {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  const override = typeof settings.walkthroughModelOverride === 'string'
    ? settings.walkthroughModelOverride.trim()
    : '';
  return override || null;
}

export function readWalkthroughModelVariant() {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  if (!readWalkthroughModelOverride()) return null;
  return asNonEmptyString(settings.walkthroughModelVariant);
}
