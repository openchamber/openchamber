import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJsonFileWithBackup, readJsonFileWithBackupSync } from './settings-file.js';

describe('settings backup reads', () => {
  let directory;
  let settingsPath;

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-settings-file-'));
    settingsPath = path.join(directory, 'settings.json');
  });

  afterEach(() => fsp.rm(directory, { recursive: true, force: true }));

  it('uses the backup when the canonical file is unavailable', async () => {
    await fsp.writeFile(`${settingsPath}.backup-1-electron`, '{"theme":"old"}');

    await expect(readJsonFileWithBackup(fsp, settingsPath)).resolves.toEqual({ theme: 'old' });
  });

  it('uses the backup when the canonical file is missing', () => {
    fs.writeFileSync(`${settingsPath}.backup-1-electron`, '{"theme":"old"}');

    expect(readJsonFileWithBackupSync(fs, settingsPath)).toEqual({ theme: 'old' });
  });

  it('uses the newest valid recovery backup', async () => {
    await fsp.writeFile(`${settingsPath}.backup-1-electron`, '{"theme":"old"}');
    await fsp.writeFile(`${settingsPath}.backup-2-electron`, '{"theme":"newer"}');

    await expect(readJsonFileWithBackup(fsp, settingsPath)).resolves.toEqual({ theme: 'newer' });
  });

  it('does not hide malformed recovery data as a missing canonical file', async () => {
    await fsp.writeFile(`${settingsPath}.backup-1-electron`, '{"theme":"stale"}');
    await fsp.writeFile(`${settingsPath}.backup-2-electron`, '{');

    await expect(readJsonFileWithBackup(fsp, settingsPath)).rejects.toBeInstanceOf(SyntaxError);
  });
});
