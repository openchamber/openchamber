import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeSharedSettings, readSharedSettingsFile } from './shared-settings-file';

test('preserves backup fields while preparing a partial settings write', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-settings-'));
  const settingsPath = path.join(directory, 'settings.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(`${settingsPath}.backup-1-electron`, '{"theme":"old"}');

  const current = readSharedSettingsFile(settingsPath);
  assert.deepEqual(mergeSharedSettings(current, { chatMessageWidthMode: 'fluid' }), {
    theme: 'old',
    chatMessageWidthMode: 'fluid',
  });
});
