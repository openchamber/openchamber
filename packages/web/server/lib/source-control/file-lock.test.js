import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withSourceControlFileLock } from './file-lock.js';
import { storageProcess } from './storage-process.test-support.js';

const directories = [];
const children = [];
const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-control-lock-'));
  directories.push(directory);
  return path.join(directory, 'snapshot.json.lock');
};
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

it('creates mode 0600 with unique identity and releases after success or operation failure', async () => {
  const lockPath = await setup();
  const nonces = [];
  for (const fail of [false, true, false]) {
    const operation = withSourceControlFileLock(lockPath, async () => {
      nonces.push(await fs.readFile(lockPath, 'utf8'));
      expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
      if (fail) throw new Error('operation failed');
      return 7;
    });
    if (fail) await expect(operation).rejects.toThrow('operation failed');
    else await expect(operation).resolves.toBe(7);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(new Set(nonces).size).toBe(3);
});

it.each(['', '{malformed', '{"pid":999999999,"at":1}'])('preserves malformed and old locks without stealing', async (content) => {
  const lockPath = await setup();
  await fs.writeFile(lockPath, content, { mode: 0o600 });
  await fs.utimes(lockPath, new Date(0), new Date(0));
  await expect(withSourceControlFileLock(lockPath, () => { throw new Error('must not run'); }, { waitMs: 25 }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503, message: expect.stringContaining('stop all writers') });
  expect(await fs.readFile(lockPath, 'utf8')).toBe(content);
});

it('preserves a crashed process lock until deliberate cleanup with all writers stopped', async () => {
  const lockPath = await setup();
  const owner = await storageProcess('lock', lockPath);
  children.push(owner);
  owner.call('hold-lock');
  await expect.poll(() => owner.events.some((event) => event.event === 'locked')).toBe(true);
  const nonce = await fs.readFile(lockPath, 'utf8');
  await owner.stop();
  await expect(withSourceControlFileLock(lockPath, () => 1, { waitMs: 25 }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY' });
  expect(await fs.readFile(lockPath, 'utf8')).toBe(nonce);
  await fs.unlink(lockPath);
  await expect(withSourceControlFileLock(lockPath, () => 1)).resolves.toBe(1);
});

it('never releases a replacement identity', async () => {
  const lockPath = await setup();
  await expect(withSourceControlFileLock(lockPath, async () => {
    await fs.rename(lockPath, `${lockPath}.original`);
    await fs.writeFile(lockPath, 'replacement');
  })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_FAILED', status: 500 });
  expect(await fs.readFile(lockPath, 'utf8')).toBe('replacement');
});

it('cleans its own partial initialization failure and reports acquisition I/O failures', async () => {
  const lockPath = await setup();
  const fsImpl = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    handle.writeFile = async () => { throw new Error('write failed'); };
    return handle;
  } };
  await expect(withSourceControlFileLock(lockPath, () => 1, { fsImpl }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_FAILED', status: 500 });
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(withSourceControlFileLock(lockPath, () => 1, { fsImpl: { ...fs, open: async () => { throw new Error('unavailable'); } } }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_FAILED', status: 500 });
  await expect(withSourceControlFileLock(lockPath, () => 1)).resolves.toBe(1);
});
