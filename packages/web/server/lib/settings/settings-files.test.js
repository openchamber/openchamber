import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MERGED_PREFERENCES_MAX_BYTES,
  MERGED_SETTINGS_MAX_BYTES,
  readMergedSettingsSync,
} from './settings-files.js';

// The merged hot-path read (#1631): both documents go through the shared
// bounded reader, so these tests use real files (and a real FIFO) in a
// temp directory — never a fake-fs stub, which the bounded reader does
// not consult.

const isWindows = process.platform === 'win32';

let dir;
let warn;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-files-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  warn?.mockRestore();
  warn = undefined;
});

const spyWarn = () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return warn;
};

const writeSettings = (name, content) => {
  const settingsFilePath = path.join(dir, name, 'settings.json');
  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  fs.writeFileSync(settingsFilePath, content);
  return settingsFilePath;
};

const writePreferences = (settingsFilePath, content) => {
  fs.writeFileSync(path.join(path.dirname(settingsFilePath), 'preferences.json'), content);
};

const read = (settingsFilePath) => readMergedSettingsSync({ fs, path, settingsFilePath });

const preferencesDoc = (fields) => JSON.stringify({ version: 1, fields });

describe('readMergedSettingsSync bounded reads (#1631)', () => {
  it('merges ordinary settings and preferences files as before', () => {
    const settingsFilePath = writeSettings('ordinary', JSON.stringify({ instanceKey: 'a', themeId: 'from-settings' }));
    writePreferences(settingsFilePath, preferencesDoc({ themeId: { value: 'dark', updatedAt: 1 } }));
    expect(read(settingsFilePath)).toEqual({ instanceKey: 'a', themeId: 'dark' });
  });

  it('treats missing files as empty, silently', () => {
    const spy = spyWarn();
    const settingsFilePath = path.join(dir, 'missing', 'settings.json');
    expect(read(settingsFilePath)).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a malformed settings document contributing nothing, as today', () => {
    const settingsFilePath = writeSettings('malformed', '{not json');
    expect(read(settingsFilePath)).toEqual({});
  });

  it('refuses an oversized settings.json without parsing it, and warns', () => {
    const spy = spyWarn();
    const settingsFilePath = writeSettings(
      'oversized-settings',
      JSON.stringify({ huge: 'x'.repeat(MERGED_SETTINGS_MAX_BYTES) }),
    );
    writePreferences(settingsFilePath, preferencesDoc({ themeId: { value: 'dark', updatedAt: 1 } }));
    const merged = read(settingsFilePath);
    expect(merged).toEqual({ themeId: 'dark' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('exceeds the'));
  });

  it('refuses an oversized preferences.json without parsing it, and warns', () => {
    const spy = spyWarn();
    const settingsFilePath = writeSettings('oversized-prefs', JSON.stringify({ instanceKey: 'a' }));
    writePreferences(
      settingsFilePath,
      preferencesDoc({ themeId: { value: 'x'.repeat(MERGED_PREFERENCES_MAX_BYTES), updatedAt: 1 } }),
    );
    const merged = read(settingsFilePath);
    expect(merged).toEqual({ instanceKey: 'a' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('exceeds the'));
  });

  it.skipIf(isWindows)('returns promptly with a FIFO at the settings path, and warns', () => {
    const spy = spyWarn();
    const settingsFilePath = path.join(dir, 'fifo-settings', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
    execFileSync('mkfifo', [settingsFilePath]);
    writePreferences(settingsFilePath, preferencesDoc({ themeId: { value: 'dark', updatedAt: 1 } }));
    expect(read(settingsFilePath)).toEqual({ themeId: 'dark' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not a regular file'));
  });

  it.skipIf(isWindows)('returns promptly with a FIFO at the preferences path, and warns', () => {
    const spy = spyWarn();
    const settingsFilePath = writeSettings('fifo-prefs', JSON.stringify({ instanceKey: 'a' }));
    execFileSync('mkfifo', [path.join(path.dirname(settingsFilePath), 'preferences.json')]);
    expect(read(settingsFilePath)).toEqual({ instanceKey: 'a' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not a regular file'));
  });
});
