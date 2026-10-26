import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { asNonEmptyString } from '../shared/guards.js';

// The walkthrough may run on a different model than the rest of the small-model
// callers. Those callers want cheap and fast; this one needs structured output
// and enough context for a whole diff, and forcing one setting to serve both
// means the user has to degrade one feature to fix the other.

const SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/**
 * The explicit walkthrough model, or `null` to fall back to normal small-model
 * resolution.
 *
 * Having chosen a model *is* the opt-out; a separate toggle would let the two
 * disagree, and then clearing the picker would leave a setting that says "do
 * not use the small model" with nothing to use instead.
 */
export function readWalkthroughModelOverride() {
  // No settings file, unreadable, or malformed all mean the same thing: no
  // override, use the small model.
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  const override = typeof settings.walkthroughModelOverride === 'string'
    ? settings.walkthroughModelOverride.trim()
    : '';
  return override || null;
}

/**
 * The thinking variant chosen beside the walkthrough model, or `null`. It
 * belongs to that model: without an override there is nothing to apply it to.
 */
export function readWalkthroughModelVariant() {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: SETTINGS_FILE });
  if (!readWalkthroughModelOverride()) return null;
  return asNonEmptyString(settings.walkthroughModelVariant);
}
