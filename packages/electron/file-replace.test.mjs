import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceFile } from './file-replace.mjs';

test('falls back after Windows repeatedly blocks atomic file replacement', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  let renameAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async () => {
    renameAttempts += 1;
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  });

  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');
  await replaceFile(temporaryPath, targetPath, 'win32');

  assert.equal(renameAttempts, 6);
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'new settings');
  await assert.rejects(fsp.access(temporaryPath), { code: 'ENOENT' });
});

test('does not mask non-transient replacement errors', async (t) => {
  let renameAttempts = 0;
  t.mock.method(fsp, 'rename', async () => {
    renameAttempts += 1;
    const error = new Error('input/output error');
    error.code = 'EIO';
    throw error;
  });

  await assert.rejects(replaceFile('temporary', 'target', 'win32'), { code: 'EIO' });
  assert.equal(renameAttempts, 1);
});
