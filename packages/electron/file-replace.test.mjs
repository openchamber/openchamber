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
    if (renameAttempts <= 7) {
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
  const link = fsp.link.bind(fsp);
  let renameAttempts = 0;
  let linkAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 7) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return rename(...args);
  });
  t.mock.method(fsp, 'link', async (...args) => {
    linkAttempts += 1;
    if (linkAttempts === 2) {
      const error = new Error('input/output error');
      error.code = 'EIO';
      throw error;
    }
    return link(...args);
  });

  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'EIO' });
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'old settings');
  assert.equal(await fsp.readFile(temporaryPath, 'utf8'), 'new settings');
  assert.equal(linkAttempts, 3);
});

test('reads the backup when fallback rollback also fails', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  const link = fsp.link.bind(fsp);
  let renameAttempts = 0;
  let linkAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 7) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return rename(...args);
  });
  t.mock.method(fsp, 'link', async (...args) => {
    linkAttempts += 1;
    if (linkAttempts === 1) return link(...args);
    const error = new Error('input/output error');
    error.code = 'EIO';
    throw error;
  });

  await fsp.writeFile(temporaryPath, '{"theme":"new"}');
  await fsp.writeFile(targetPath, '{"theme":"old"}');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'EIO' });
  assert.deepEqual(readJsonFileWithBackup(targetPath), { theme: 'old' });
  await assert.rejects(fsp.access(targetPath), { code: 'ENOENT' });
  const backupName = (await fsp.readdir(directory)).find((name) => name.startsWith('settings.json.backup-'));
  assert.equal(await fsp.readFile(path.join(directory, backupName), 'utf8'), '{"theme":"old"}');
});

test('does not overwrite a concurrent writer while rolling back', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const temporaryPath = path.join(directory, 'settings.json.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  const link = fsp.link.bind(fsp);
  let renameAttempts = 0;
  let linkAttempts = 0;
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (...args) => {
    renameAttempts += 1;
    if (renameAttempts <= 7) {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return rename(...args);
  });
  t.mock.method(fsp, 'link', async (...args) => {
    linkAttempts += 1;
    if (linkAttempts === 2) {
      await fsp.writeFile(targetPath, 'concurrent settings');
    }
    return link(...args);
  });
  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'EEXIST' });

  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'concurrent settings');
  assert.equal(linkAttempts, 3);
  const backupName = (await fsp.readdir(directory)).find((name) => name.startsWith('settings.json.backup-'));
  assert.equal(await fsp.readFile(path.join(directory, backupName), 'utf8'), 'old settings');
});

test('keeps the canonical file when hard links are unavailable', async (t) => {
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
  t.mock.method(fsp, 'link', async () => {
    const error = new Error('operation not supported');
    error.code = 'ENOTSUP';
    throw error;
  });
  await fsp.writeFile(temporaryPath, 'new settings');
  await fsp.writeFile(targetPath, 'old settings');

  await assert.rejects(replaceFile(temporaryPath, targetPath, 'win32'), { code: 'ENOTSUP' });

  assert.equal(renameAttempts, 7);
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'old settings');
  assert.equal(await fsp.readFile(temporaryPath, 'utf8'), 'new settings');
});

test('serializes concurrent Windows fallbacks', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-replace-'));
  const firstTemporaryPath = path.join(directory, 'settings.json.first.tmp');
  const secondTemporaryPath = path.join(directory, 'settings.json.second.tmp');
  const targetPath = path.join(directory, 'settings.json');
  const rename = fsp.rename.bind(fsp);
  const attempts = new Map();
  let backupMoves = 0;
  let releaseFirstFallback;
  const holdFirstFallback = new Promise((resolve) => {
    releaseFirstFallback = resolve;
  });
  let firstFallbackEntered;
  const firstFallback = new Promise((resolve) => {
    firstFallbackEntered = resolve;
  });
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === targetPath && (from === firstTemporaryPath || from === secondTemporaryPath)) {
      const attempt = (attempts.get(from) || 0) + 1;
      attempts.set(from, attempt);
      if (attempt <= 7) {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      }
    }
    if (from === targetPath && to.startsWith(`${targetPath}.backup-`)) {
      backupMoves += 1;
      if (backupMoves === 1) {
        firstFallbackEntered();
        await holdFirstFallback;
      }
    }
    return rename(from, to);
  });
  await fsp.writeFile(firstTemporaryPath, 'first settings');
  await fsp.writeFile(secondTemporaryPath, 'second settings');
  await fsp.writeFile(targetPath, 'old settings');

  const firstReplacement = replaceFile(firstTemporaryPath, targetPath, 'win32');
  const secondReplacement = replaceFile(secondTemporaryPath, targetPath, 'win32');
  await firstFallback;

  assert.equal(attempts.get(firstTemporaryPath), 7);
  assert.equal(attempts.get(secondTemporaryPath), 6);
  assert.equal(backupMoves, 1);

  releaseFirstFallback();
  await Promise.all([firstReplacement, secondReplacement]);
  assert.equal(backupMoves, 2);
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'second settings');
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
