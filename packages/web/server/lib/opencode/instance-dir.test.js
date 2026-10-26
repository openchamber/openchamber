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

  it('keeps its own folder from an earlier run with the same pid', async () => {
    const dataDir = await createDataDir();
    const ownDir = path.join(instancesDirOf(dataDir), '606');
    await fs.mkdir(ownDir, { recursive: true });
    await fs.writeFile(path.join(ownDir, 'file'), 'kept');

    await prepareInstanceDir({ fsPromises: fs, path, dataDir, pid: 606, isPidAlive: () => false });

    expect(await fs.readFile(path.join(ownDir, 'file'), 'utf8')).toBe('kept');
  });
});
