import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CATALOG_CACHE_MAX_ENTRIES,
  catalogCache,
  clearCatalogCacheForTests,
  copyDirectoryNoSymlinks,
  pruneCatalogCache,
} from './skillsCatalog';

describe('skills catalog cache pruning (#998)', () => {
  afterEach(() => {
    clearCatalogCacheForTests();
  });

  test('sweeps expired entries for keys that are never re-read, and keeps live ones', () => {
    const now = 1_000_000;
    catalogCache.set('expired::', { expiresAt: now - 1, items: [] });
    catalogCache.set('live::', { expiresAt: now + 60_000, items: [] });

    pruneCatalogCache(now);

    assert.equal(catalogCache.has('expired::'), false);
    assert.equal(catalogCache.has('live::'), true);
    assert.equal(catalogCache.size, 1);
  });

  test('enforces the max-entries bound oldest-first', () => {
    const now = 1_000_000;
    for (let i = 0; i < CATALOG_CACHE_MAX_ENTRIES + 5; i += 1) {
      catalogCache.set(`source-${i}::`, { expiresAt: now + 60_000, items: [] });
    }

    pruneCatalogCache(now);

    assert.equal(catalogCache.size, CATALOG_CACHE_MAX_ENTRIES);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(catalogCache.has(`source-${i}::`), false);
    }
    assert.equal(catalogCache.has(`source-${CATALOG_CACHE_MAX_ENTRIES + 4}::`), true);
  });
});

describe('skillsCatalog install-copy caps (#2301, mirrors PR #2297 web twin)', () => {
  const tempDirs: string[] = [];

  const makeTemp = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    clearCatalogCacheForTests();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeSkill = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`);
  };

  test('installs a SKILL.md up to the 4 MiB limit', async () => {
    const src = path.join(makeTemp('oc-vscode-clone-'), 'skills', 'big');
    writeSkill(src, 'big');
    // 2 MiB SKILL.md: above the 1 MiB supporting-file cap but within the
    // 4 MiB SKILL.md contract.
    fs.writeFileSync(path.join(src, 'SKILL.md'), Buffer.alloc(2 * 1024 * 1024));
    const dst = path.join(makeTemp('oc-vscode-dst-'), 'big');

    await copyDirectoryNoSymlinks(src, dst);

    assert.equal(fs.statSync(path.join(dst, 'SKILL.md')).size, 2 * 1024 * 1024);
  });

  test('aborts on a SKILL.md above the 4 MiB limit', async () => {
    const src = path.join(makeTemp('oc-vscode-clone-'), 'skills', 'big');
    writeSkill(src, 'big');
    fs.writeFileSync(path.join(src, 'SKILL.md'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const dst = path.join(makeTemp('oc-vscode-dst-'), 'big');

    await assert.rejects(copyDirectoryNoSymlinks(src, dst), /exceeds the 4194304 byte limit/);
  });

  test('aborts on a supporting file above the 1 MiB limit', async () => {
    const src = path.join(makeTemp('oc-vscode-clone-'), 'skills', 'big');
    writeSkill(src, 'big');
    fs.writeFileSync(path.join(src, 'huge.bin'), Buffer.alloc(1024 * 1024 + 1));
    const dst = path.join(makeTemp('oc-vscode-dst-'), 'big');

    await assert.rejects(copyDirectoryNoSymlinks(src, dst), /exceeds the 1048576 byte limit/);
  });
});
