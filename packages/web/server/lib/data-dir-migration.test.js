import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';

import { migrateLegacyUserDirs } from './data-dir-migration.js';

const setup = async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-data-dir-'));
  const legacyRoot = path.join(root, 'legacy');
  const dataDir = path.join(root, 'custom');
  await fsPromises.mkdir(path.join(legacyRoot, 'projects'), { recursive: true });
  await fsPromises.writeFile(path.join(legacyRoot, 'projects', 'p.json'), '{"a":1}');
  await fsPromises.mkdir(path.join(legacyRoot, 'themes'), { recursive: true });
  return { root, legacyRoot, dataDir, cleanup: () => fsPromises.rm(root, { recursive: true, force: true }) };
};

describe('migrateLegacyUserDirs', () => {
  it('copies the user folders once into a custom data dir and leaves the originals', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      const warnings = [];
      const moved = await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
      expect(moved).toEqual(['projects', 'themes']);
      expect(warnings).toEqual([]);
      expect(await fsPromises.readFile(path.join(dataDir, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      // The default instance keeps its own copy: a second instance must not strip it.
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      // A second start copies nothing more.
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('never merges into a folder that already exists in the data dir', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      await fsPromises.mkdir(path.join(dataDir, 'projects'), { recursive: true });
      await fsPromises.writeFile(path.join(dataDir, 'projects', 'q.json'), '{}');
      const moved = await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot });
      expect(moved).toEqual(['themes']);
      expect(await fsPromises.readdir(path.join(dataDir, 'projects'))).toEqual(['q.json']);
      expect(await fsPromises.readdir(path.join(legacyRoot, 'projects'))).toEqual(['p.json']);
    } finally {
      await cleanup();
    }
  });

  it('is a no-op when the data dir is the default root', async () => {
    const { legacyRoot, cleanup } = await setup();
    try {
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir: legacyRoot, legacyRoot })).toEqual([]);
      expect(await fsPromises.readdir(path.join(legacyRoot, 'projects'))).toEqual(['p.json']);
    } finally {
      await cleanup();
    }
  });
});
