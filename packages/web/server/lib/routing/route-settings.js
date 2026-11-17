/**
 * Settings for the rules interpreter: which stages run and the thresholds
 * behind learning and wait estimates. Stored in OpenChamber's own settings
 * directory, never in the OpenCode config. Every value has a default that works,
 * so the file only needs to exist once the user changes something.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  preserveMalformedJsonFileSync,
  readDurableJsonFileSync,
  writeDurableJsonFileSync,
} from '../shared/durable-json-store.js';
import { DEFAULT_TOGGLES } from './route-interpreter.js';

export const DEFAULT_SETTINGS = {
  stages: { ...DEFAULT_TOGGLES },
  learnAfter: 3,
  waitPercentile: 25,
  waitMinSamples: 5,
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

export const normalizeSettings = (input = {}) => ({
  stages: {
    keywords: input.stages?.keywords !== false,
    local: input.stages?.local !== false,
    external: input.stages?.external !== false,
  },
  learnAfter: clamp(input.learnAfter, 1, 20, DEFAULT_SETTINGS.learnAfter),
  waitPercentile: clamp(input.waitPercentile, 5, 75, DEFAULT_SETTINGS.waitPercentile),
  waitMinSamples: clamp(input.waitMinSamples, 1, 100, DEFAULT_SETTINGS.waitMinSamples),
});

const resolveSettingsFile = (env = process.env) => {
  const dir = env.OPENCHAMBER_DATA_DIR?.trim()
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(dir, 'route-settings.json');
};

export const createSettingsStore = ({ file = resolveSettingsFile() } = {}) => {
  // This store rides the shared durable-store primitive (design #976):
  // the sync spellings match this store's synchronous read and write.
  // The value judgement stays the one this store always made: a parsed
  // value normalizeSettings rejects (a JSON null is the documented case)
  // is as malformed as unparseable bytes. The parse or normalize error
  // itself is never logged: JSON.parse messages quote the file content,
  // which is user data.
  const validateValue = (value) => {
    try {
      normalizeSettings(value);
      return true;
    } catch {
      return false;
    }
  };

  const read = () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result;
      try {
        result = readDurableJsonFileSync(file, { validateValue });
      } catch (error) {
        // A read failure other than absence (EACCES, EISDIR, ...) warns
        // and defaults, the behaviour this store always had.
        console.warn('Failed to read route settings file:', error);
        return normalizeSettings({});
      }
      if (result.state === 'valid') return normalizeSettings(result.value);
      // The primitive collapses an absent file and an existing empty
      // file into 'missing'. An empty file holds no settings, so there
      // is nothing to preserve in either case.
      if (result.state === 'missing') return normalizeSettings({});
      // A torn or otherwise unparseable settings file is user data, not
      // the defaults: move its bytes aside before any later write can
      // overwrite them, and name the preserved copy so the loss is
      // recoverable. The read itself never fails closed: it defaults.
      const preservation = preserveMalformedJsonFileSync(file, { validateValue });
      if (preservation.preserved) {
        console.warn(`Failed to read route settings file: preserved the unreadable file at ${preservation.preservedPath}`);
        return normalizeSettings({});
      }
      // A valid replacement landed while the malformed bytes were being
      // judged: read that file instead of defaulting.
      if (preservation.outcome === 'replaced') continue;
      console.warn('Failed to read route settings file: the file could not be parsed');
      console.warn('Failed to preserve the unreadable route settings file');
      return normalizeSettings({});
    }
    return normalizeSettings({});
  };

  const write = (input) => {
    const next = normalizeSettings(input);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A write must not overwrite an unpreserved corrupt file: the
    // preserve helper re-reads and re-judges the on-disk bytes, and any
    // failure to read, judge, or preserve them refuses the write. A
    // valid file, an absent file, and an empty file need no preservation
    // and the write proceeds.
    const preservation = preserveMalformedJsonFileSync(file, { validateValue });
    if (preservation.outcome === 'failed') {
      throw new Error(`Refusing to overwrite the unreadable route settings file at ${file}: it could not be preserved`);
    }
    if (preservation.preserved) {
      console.warn(`Failed to read route settings file: preserved the unreadable file at ${preservation.preservedPath}`);
    }
    // The file mode is stated explicitly through the primitive: this
    // store never restricted its file (a plain write under the process
    // umask), so 0o666 keeps the effective mode it always had.
    writeDurableJsonFileSync(file, JSON.stringify(next, null, 2), { mode: 0o666 });
    return next;
  };

  return { read, write };
};
