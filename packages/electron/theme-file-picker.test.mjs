import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pickThemeFile } from './theme-file-picker.mjs';

test('uses the local VS Code folder only when present and returns bounded contents without exposing paths', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-theme-picker-'));
  try {
    await pickThemeFile({ home, showDialog: async (options) => {
      assert.equal(options.defaultPath, undefined);
      return { canceled: true, filePaths: [] };
    } });
    const extensions = path.join(home, '.vscode', 'extensions');
    await fs.mkdir(extensions, { recursive: true });
    const file = path.join(extensions, 'theme.jsonc');
    await fs.writeFile(file, '// theme');
    const picked = await pickThemeFile({ home, showDialog: async (options) => {
      assert.equal(options.defaultPath, extensions);
      assert.deepEqual(options.filters[0].extensions, ['json', 'jsonc']);
      return { canceled: false, filePaths: [file] };
    } });
    assert.deepEqual(picked, { name: 'theme.jsonc', size: 8, text: '// theme' });
    await fs.writeFile(file, ' '.repeat(512 * 1024 + 1));
    const large = await pickThemeFile({ home, showDialog: async () => ({ canceled: false, filePaths: [file] }) });
    assert.equal(large.text, '');
    assert.equal(large.size, 512 * 1024 + 1);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
