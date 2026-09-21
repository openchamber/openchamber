import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// The store resolves its directory at import time from the environment, so the
// temp dir has to be in place before the module is loaded.
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-store-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_ROOT;

const store = await import('./store.js');
const {
  buildCacheKey,
  readCachedWalkthrough,
  writeCachedWalkthrough,
  readPointer,
  writePointer,
  pruneMissingRepositories,
  __testing,
} = store;

const files = (overrides = []) => ([
  {
    path: 'src/a.ts',
    status: 'modified',
    hunks: [{ id: 'working:src/a.ts:aaaa1111' }, { id: 'working:src/a.ts:bbbb2222' }],
  },
  {
    path: 'src/b.ts',
    status: 'added',
    hunks: [{ id: 'working:src/b.ts:cccc3333' }],
  },
  ...overrides,
]);

const baseKeyInput = {
  repoRoot: '/repo',
  sourceKey: 'working-tree:all',
  providerID: 'anthropic',
  modelID: 'claude-haiku-4-5',
  files: files(),
};

const entry = (cacheKey) => ({
  cacheKey,
  generatedAt: '2026-08-02T00:00:00.000Z',
  repoRoot: '/repo',
  sourceKey: 'working-tree:all',
  model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
  walkthrough: { title: 'x', focus: '', chapters: [{ id: 'chapter-1', stops: [] }] },
});

describe('buildCacheKey', () => {
  it('is stable for identical input', () => {
    expect(buildCacheKey(baseKeyInput)).toBe(buildCacheKey(baseKeyInput));
  });

  it('ignores file ordering', () => {
    const reordered = { ...baseKeyInput, files: [...baseKeyInput.files].reverse() };
    expect(buildCacheKey(reordered)).toBe(buildCacheKey(baseKeyInput));
  });

  it('changes when any hunk changes', () => {
    const edited = {
      ...baseKeyInput,
      files: [
        { ...baseKeyInput.files[0], hunks: [{ id: 'working:src/a.ts:aaaa1111' }, { id: 'working:src/a.ts:dddd4444' }] },
        baseKeyInput.files[1],
      ],
    };
    expect(buildCacheKey(edited)).not.toBe(buildCacheKey(baseKeyInput));
  });

  it('separates repositories, sources, and models', () => {
    const original = buildCacheKey(baseKeyInput);
    expect(buildCacheKey({ ...baseKeyInput, repoRoot: '/other' })).not.toBe(original);
    expect(buildCacheKey({ ...baseKeyInput, sourceKey: 'working-tree:staged' })).not.toBe(original);
    expect(buildCacheKey({ ...baseKeyInput, modelID: 'other-model' })).not.toBe(original);
    expect(buildCacheKey({ ...baseKeyInput, providerID: 'google' })).not.toBe(original);
  });
});

describe('cache entries', () => {
  beforeEach(() => {
    fs.rmSync(__testing.ENTRIES_DIR, { recursive: true, force: true });
    fs.rmSync(__testing.POINTERS_DIR, { recursive: true, force: true });
  });

  it('round-trips a walkthrough', () => {
    const key = buildCacheKey(baseKeyInput);
    expect(writeCachedWalkthrough(key, entry(key))).toBe(true);

    const read = readCachedWalkthrough(key);
    expect(read.walkthrough.title).toBe('x');
    expect(read.cacheKey).toBe(key);
  });

  it('reports a miss for an unknown key', () => {
    expect(readCachedWalkthrough('0'.repeat(64))).toBeNull();
  });

  it('treats a corrupt entry as a miss rather than throwing', () => {
    const key = buildCacheKey(baseKeyInput);
    writeCachedWalkthrough(key, entry(key));
    fs.writeFileSync(path.join(__testing.ENTRIES_DIR, `${key}.json`), '{ not json', 'utf8');

    expect(readCachedWalkthrough(key)).toBeNull();
  });

  it('rejects an entry written by an incompatible version', () => {
    const key = buildCacheKey(baseKeyInput);
    writeCachedWalkthrough(key, entry(key));
    const file = path.join(__testing.ENTRIES_DIR, `${key}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, walkthroughVersion: 999 }), 'utf8');

    expect(readCachedWalkthrough(key)).toBeNull();
  });

  it('leaves no temp files behind', () => {
    const key = buildCacheKey(baseKeyInput);
    writeCachedWalkthrough(key, entry(key));

    const leftovers = fs.readdirSync(__testing.ENTRIES_DIR).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('evicts least-recently-used entries past the count limit', () => {
    for (let index = 0; index < __testing.MAX_ENTRIES + 10; index += 1) {
      const key = buildCacheKey({ ...baseKeyInput, sourceKey: `source-${index}` });
      writeCachedWalkthrough(key, entry(key));
    }

    const remaining = fs.readdirSync(__testing.ENTRIES_DIR).filter((name) => name.endsWith('.json'));
    expect(remaining.length).toBeLessThanOrEqual(__testing.MAX_ENTRIES);
  });
});

describe('pointers', () => {
  beforeEach(() => {
    fs.rmSync(__testing.POINTERS_DIR, { recursive: true, force: true });
  });

  it('round-trips and stays scoped to its source', () => {
    writePointer('/repo', 'working-tree:all', {
      repoRoot: '/repo',
      sourceKey: 'working-tree:all',
      cacheKey: 'abc',
      generatedAt: 'now',
    });

    expect(readPointer('/repo', 'working-tree:all')).toMatchObject({ cacheKey: 'abc' });
    expect(readPointer('/repo', 'working-tree:staged')).toBeNull();
  });

  it('keeps different repositories apart', () => {
    writePointer('/repo-a', 'working-tree:all', { repoRoot: '/repo-a', cacheKey: 'a' });
    writePointer('/repo-b', 'working-tree:all', { repoRoot: '/repo-b', cacheKey: 'b' });

    expect(readPointer('/repo-a', 'working-tree:all').cacheKey).toBe('a');
    expect(readPointer('/repo-b', 'working-tree:all').cacheKey).toBe('b');
  });

  it('prunes only pointers whose repository is gone', async () => {
    const liveRepo = fs.mkdtempSync(path.join(TEMP_ROOT, 'live-repo-'));
    writePointer(liveRepo, 'working-tree:all', { repoRoot: liveRepo, cacheKey: 'live' });
    writePointer('/definitely/not/here', 'working-tree:all', {
      repoRoot: '/definitely/not/here',
      cacheKey: 'dead',
    });

    expect(await pruneMissingRepositories()).toBe(1);
    expect(readPointer(liveRepo, 'working-tree:all')).toMatchObject({ cacheKey: 'live' });
    expect(readPointer('/definitely/not/here', 'working-tree:all')).toBeNull();
  });

  it('keeps a pointer whose repository is merely unreachable', async () => {
    // A path we cannot stat for a reason other than absence — an unplugged
    // drive or a dead share behaves this way. Deleting then would cost the user
    // walkthroughs for a repository that still exists.
    const blocked = fs.mkdtempSync(path.join(TEMP_ROOT, 'blocked-'));
    const inaccessible = path.join(blocked, 'inner', 'repo');
    fs.mkdirSync(path.join(blocked, 'inner'), { recursive: true });
    fs.mkdirSync(inaccessible);
    writePointer(inaccessible, 'working-tree:all', { repoRoot: inaccessible, cacheKey: 'blocked' });
    fs.chmodSync(path.join(blocked, 'inner'), 0o000);

    try {
      expect(await pruneMissingRepositories()).toBe(0);
      expect(readPointer(inaccessible, 'working-tree:all')).toMatchObject({ cacheKey: 'blocked' });
    } finally {
      fs.chmodSync(path.join(blocked, 'inner'), 0o755);
    }
  });

  it('survives a pointer file it cannot parse', async () => {
    fs.mkdirSync(__testing.POINTERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(__testing.POINTERS_DIR, 'broken.json'), '{ not json', 'utf8');

    await expect(pruneMissingRepositories()).resolves.toBeGreaterThanOrEqual(0);
  });
});

afterAll(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
