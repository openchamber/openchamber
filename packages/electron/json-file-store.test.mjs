import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeJsonFile } from './json-file-store.mjs';

test('applies 0700 only on directory creation', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-electron-json-store-'));
  const settingsFile = path.join(root, 'settings.json');
  try {
    await writeJsonFile(settingsFile, { theme: 'dark' });

    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves a pre-existing settings directory mode across writes', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-electron-json-store-'));
  const settingsFile = path.join(root, 'settings.json');
  try {
    fs.chmodSync(root, 0o770);

    await writeJsonFile(settingsFile, { theme: 'dark' });
    assert.equal(fs.statSync(root).mode & 0o777, 0o770);

    await writeJsonFile(settingsFile, { theme: 'light' });
    assert.equal(fs.statSync(root).mode & 0o777, 0o770);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
