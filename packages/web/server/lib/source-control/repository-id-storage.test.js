import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRepositoryFilesystemId } from './repository-id-storage.js';

let dataDir;
let directory;
let stats;
let fsImpl;
const resolve = () => resolveRepositoryFilesystemId(directory, { fsImpl });
const storedPath = async () => path.join(dataDir, 'repository-identities',
  (await fs.readdir(path.join(dataDir, 'repository-identities'))).find((name) => name.endsWith('.json')));

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-repository-id-'));
  directory = path.join(dataDir, 'repo', '.git');
  stats = { ino: 12345, dev: 59, birthtimeMs: 1700000000123 };
  fsImpl = { ...fs, stat: async () => ({ ...stats }) };
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('persistent repository IDs', () => {
  it('retains IDs for 13 repositories after a remount with one read and no writes per lookup', async () => {
    const repositories = Array.from({ length: 13 }, (_, index) => `${directory}-${index}`);
    const before = await Promise.all(repositories.map((entry) => resolveRepositoryFilesystemId(entry, { fsImpl })));
    stats.dev = 63;
    const readFile = vi.fn(fs.readFile);
    const writeFile = vi.fn(fs.writeFile);
    const open = vi.fn(fs.open);
    fsImpl = { ...fsImpl, readFile, writeFile, open };
    const after = await Promise.all(repositories.map((entry) => resolveRepositoryFilesystemId(entry, { fsImpl })));
    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(13);
    expect(readFile).toHaveBeenCalledTimes(13);
    expect(writeFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['ino', 'birthtimeMs'])('refuses the previous identity when %s changes, including inode reuse', async (field) => {
    const before = await resolve();
    stats[field] += 1;
    const after = await resolve();
    expect(after).not.toBe(before);
    stats.dev = 63;
    expect(await resolve()).toBe(after);
  });

  it('gives a moved directory a different ID and isolates data roots', async () => {
    const before = await resolve();
    directory += '-moved';
    expect(await resolve()).not.toBe(before);
    directory = directory.slice(0, -6);
    vi.stubEnv('OPENCHAMBER_DATA_DIR', path.join(dataDir, 'other-instance'));
    stats.dev = 63;
    expect(await resolve()).not.toBe(before);
  });

  it('keeps device-sensitive identity when the filesystem provides no creation time', async () => {
    stats.birthtimeMs = 0;
    const before = await resolve();
    stats.dev = 63;
    expect(await resolve()).not.toBe(before);
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it('serializes concurrent first reads without replacing the established record', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, resolve));
    expect(new Set(ids).size).toBe(1);
    const filePath = await storedPath();
    const encoded = await fs.readFile(filePath, 'utf8');
    expect(encoded).not.toContain(directory);
    expect(JSON.parse(encoded)).toMatchObject({ version: 1, repositoryId: ids[0] });
    if (process.platform !== 'win32') expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    stats.dev = 63;
    expect(await resolve()).toBe(ids[0]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
    expect(await fs.readdir(path.dirname(filePath))).toHaveLength(1);
  });

  it('preserves the prior identity and cleans temporary files when a replacement write fails', async () => {
    await resolve();
    const filePath = await storedPath();
    const encoded = await fs.readFile(filePath, 'utf8');
    stats.birthtimeMs += 1;
    fsImpl.rename = async () => { throw new Error('disk unavailable'); };
    await expect(resolve()).rejects.toThrow('disk unavailable');
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
    expect(await fs.readdir(path.dirname(filePath))).toHaveLength(1);
    fsImpl.rename = fs.rename;
    expect(await resolve()).not.toBe(JSON.parse(encoded).repositoryId);
  });

  it('fails closed for unreadable or malformed records without recreating them', async () => {
    await resolve();
    const filePath = await storedPath();
    const encoded = await fs.readFile(filePath, 'utf8');
    const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
    fsImpl.readFile = async () => { throw error; };
    await expect(resolve()).rejects.toBe(error);
    fsImpl.readFile = fs.readFile;
    for (const contents of ['{', JSON.stringify({ ...JSON.parse(encoded), version: 2 }),
      JSON.stringify({ ...JSON.parse(encoded), extra: true })]) {
      await fs.writeFile(filePath, contents);
      await expect(resolve()).rejects.toMatchObject({ code: 'INVALID_REPOSITORY_IDENTITY' });
      expect(await fs.readFile(filePath, 'utf8')).toBe(contents);
    }
  });
});
