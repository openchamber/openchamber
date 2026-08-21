import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJsonFileWithBackup, replaceFile } from './file-replace.mjs';

test('moves the old file aside after Windows repeatedly blocks atomic replacement', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  let renameAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 6) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return rename(...args);
  });

  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');
  await replaceFile(temporaryPath, targetPath, 'win32');

  assert.equal(renameAttempts, 8);
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'new settings');
  await assert.rejects(fsp.access(temporaryPath), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readdir(directory), ['settings.json']);
});

test('restores the old file when fallback promotion fails', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  let renameAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 6) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    if (renameAttempts === 8) {
      const error = new Error('input/output error');
      error.code = 'EIO';
      throw error;
    }
    return rename(...args);
  });

  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'EIO' });
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'old settings');
  assert.equal(await fsp.readFile(temporaryPath, 'utf8'), 'new settings');
});

test('reads the backup when fallback rollback also fails', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  let renameAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 6) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    if (renameAttempts >= 8) {
      const error = new Error('input/output error');
      error.code = 'EIO';
      throw error;
    }
    return rename(...args);
  });

  await fsp.writeFile(temporaryPath, '{"theme":"new"}');
  await fsp.writeFile(targetPath, '{"theme":"old"}');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'EIO' });
  assert.deepEqual(readJsonFileWithBackup(targetPath), { theme: 'old' });
  await assert.rejects(fsp.access(targetPath), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(`${targetPath}.backup`, 'utf8'), '{"theme":"old"}');
});

test('does not mask non-transient replacement errors', async (t) => {
  let renameAttempts = 0;
  t.mock.method(fsp, 'access', async () => {});
  t.mock.method(fsp, 'rename', async () => {
    renameAttempts += 1;
    const error = new Error('input/output error');
    error.code = 'EIO';
    throw error;
  });

  await assert.rejects(replaceFile('temporary', 'target', 'win32'), { code: 'EIO' });
  assert.equal(renameAttempts, 1);
});
