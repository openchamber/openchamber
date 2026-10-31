import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLocalPreferences, writeLocalPreferences } from './preferences.js';

// The package's vitest setup (`test/isolated-data-dir.ts`) already points
// `OPENCHAMBER_DATA_DIR` at a per-file temp dir; these tests set their own so
// the storage location is explicit and never a real user data dir.
const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-local-preferences-'));

describe('local preferences', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults to sessionComments on and round-trips a write', async () => {
    expect(await readLocalPreferences()).toEqual({ sessionComments: true });
    await writeLocalPreferences({ sessionComments: false });
    expect(await readLocalPreferences()).toEqual({ sessionComments: false });
  });

  it('falls back to the defaults on a malformed or unexpected file', async () => {
    fs.writeFileSync(path.join(dataDir, 'local-tracker.json'), '{ not json', 'utf8');
    expect(await readLocalPreferences()).toEqual({ sessionComments: true });

    fs.writeFileSync(
      path.join(dataDir, 'local-tracker.json'),
      JSON.stringify({ sessionComments: 'yes', unrelated: 1 }),
      'utf8',
    );
    expect(await readLocalPreferences()).toEqual({ sessionComments: true });

    // A write with an unexpected shape stores the defaults, so the file never
    // carries a value a later read would interpret differently.
    expect(await writeLocalPreferences({ sessionComments: 'no' })).toEqual({ sessionComments: true });
    expect(await readLocalPreferences()).toEqual({ sessionComments: true });
  });
});
