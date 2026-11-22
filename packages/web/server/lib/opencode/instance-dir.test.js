import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareInstanceDir } from './instance-dir.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createDataDir = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-instance-dir-'));
  temporaryDirectories.push(dataDir);
  return dataDir;
};

const instancesDirOf = (dataDir) => path.join(dataDir, 'run', 'instances');

describe('prepareInstanceDir', () => {
  it('gives two servers on one data directory separate folders', async () => {
    const dataDir = await createDataDir();
    const alive = new Set([101, 202]);
    const isPidAlive = (pid) => alive.has(pid);

    const first = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 101, isPidAlive });
    await fs.writeFile(path.join(first, 'opencode.managed.json'), 'first');
    const second = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 202, isPidAlive });

    expect(first).toBe(path.join(instancesDirOf(dataDir), '101'));
    expect(second).toBe(path.join(instancesDirOf(dataDir), '202'));
    expect(await fs.readFile(path.join(first, 'opencode.managed.json'), 'utf8')).toBe('first');
  });

  it('removes folders of servers that are gone and keeps everything else', async () => {
    const dataDir = await createDataDir();
    const instancesDir = instancesDirOf(dataDir);
    for (const name of ['303', '404', 'notes']) {
      await fs.mkdir(path.join(instancesDir, name), { recursive: true });
      await fs.writeFile(path.join(instancesDir, name, 'file'), name);
    }

    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 505, isPidAlive: (pid) => pid === 404 });

    expect((await fs.readdir(instancesDir)).sort()).toEqual(['404', '505', 'notes']);
  });

  it.skipIf(process.platform === 'win32')('a FIFO owner file refuses promptly into the folder-name fallback (#1793)', async () => {
    const dataDir = await createDataDir();
    const instancesDir = instancesDirOf(dataDir);
    const folder = path.join(instancesDir, '707');
    await fs.mkdir(folder, { recursive: true });
    execFileSync('mkfifo', [path.join(folder, 'owner')]);

    // The whole-file read this replaces never settles on a FIFO; settling
    // at all is the assertion. The fallback pid (the folder name) is
    // alive, so the folder is kept.
    const dir = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 505, isPidAlive: (pid) => pid === 707 });

    expect(dir).toBe(path.join(instancesDir, '505'));
    expect((await fs.readdir(instancesDir)).sort()).toEqual(['505', '707']);
  });

  it('an over-cap owner file refuses into the folder-name fallback (#1793)', async () => {
    const dataDir = await createDataDir();
    const instancesDir = instancesDirOf(dataDir);
    const folder = path.join(instancesDir, '909');
    await fs.mkdir(folder, { recursive: true });
    // A whole read would parseInt the leading 808 (dead) and the folder
    // would be removed as abandoned; the bounded read refuses, so the
    // owner is the folder-name pid 909, which is alive and kept.
    await fs.writeFile(path.join(folder, 'owner'), `808\n${' '.repeat(4096)}`);

    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 505, isPidAlive: (pid) => pid === 909 });

    expect((await fs.readdir(instancesDir)).sort()).toEqual(['505', '909']);
  });

  it('keeps its own folder from an earlier run with the same pid', async () => {
    const dataDir = await createDataDir();
    const ownDir = path.join(instancesDirOf(dataDir), '606');
    await fs.mkdir(ownDir, { recursive: true });
    await fs.writeFile(path.join(ownDir, 'file'), 'kept');

    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 606, isPidAlive: () => false });

    expect(await fs.readFile(path.join(ownDir, 'file'), 'utf8')).toBe('kept');
  });
});

// A managed OpenCode outlives its server, and the server that adopts it must
// keep the folder that OpenCode reads its config from.
describe('prepareInstanceDir with a folder to claim', () => {
  const seedFolder = async (dataDir, name) => {
    const dir = path.join(instancesDirOf(dataDir), name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'opencode.managed.json'), name);
    return dir;
  };

  it('takes over the folder of a server that is gone, and records itself as owner', async () => {
    const dataDir = await createDataDir();
    const saved = await seedFolder(dataDir, '111');

    const dir = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 222, isPidAlive: (pid) => pid === 222, claimDir: saved });

    expect(dir).toBe(saved);
    expect(await fs.readFile(path.join(saved, 'opencode.managed.json'), 'utf8')).toBe('111');
    expect((await fs.readFile(path.join(saved, 'owner'), 'utf8')).trim()).toBe('222');
    expect(await fs.readdir(instancesDirOf(dataDir))).toEqual(['111']);
  });

  it('takes over the folder of the live predecessor handing off to it', async () => {
    const dataDir = await createDataDir();
    const saved = await seedFolder(dataDir, '111');

    const dir = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 222, isPidAlive: () => true, claimDir: saved, handoffFrom: 111 });

    expect(dir).toBe(saved);
  });

  it('leaves a live server that is not its predecessor its folder, and makes its own', async () => {
    const dataDir = await createDataDir();
    const saved = await seedFolder(dataDir, '111');

    const dir = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 222, isPidAlive: () => true, claimDir: saved, handoffFrom: 999 });

    expect(dir).toBe(path.join(instancesDirOf(dataDir), '222'));
    await expect(fs.access(path.join(saved, 'owner'))).rejects.toThrow();
  });

  it('never claims a folder outside run/instances', async () => {
    const dataDir = await createDataDir();
    const outside = path.join(dataDir, '111');
    await fs.mkdir(outside, { recursive: true });

    const dir = await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 222, isPidAlive: () => false, claimDir: outside });

    expect(dir).toBe(path.join(instancesDirOf(dataDir), '222'));
  });

  it('keeps a claimed folder while its new owner lives, even though the server it is named after is gone', async () => {
    const dataDir = await createDataDir();
    const saved = await seedFolder(dataDir, '111');
    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 222, isPidAlive: () => false, claimDir: saved });

    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 333, isPidAlive: (pid) => pid === 222 || pid === 333 });

    expect((await fs.readdir(instancesDirOf(dataDir))).sort()).toEqual(['111', '333']);
  });
});
