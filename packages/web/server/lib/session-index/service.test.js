import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionIndexService } from './service.js';

const tempDirectories = [];

const createService = (runtimeRef) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-index-'));
  tempDirectories.push(directory);
  return createSessionIndexService({
    dbPath: path.join(directory, 'session-index.sqlite'),
    getRuntimeConfig: () => ({ apiBaseUrl: runtimeRef.value }),
  });
};

const session = (id, updated, directory = '/repo') => ({
  id,
  title: `Session ${id}`,
  directory,
  time: { created: updated - 1, updated },
});

afterEach(() => {
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe('Electron session index', () => {
  it('stores one bounded root-session page transactionally', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    const sessions = Array.from({ length: 24 }, (_, index) => session(`ses_${index}`, 100 - index));

    service.replaceDirectory({ directory: '/repo', sessions, cursor: 80, hasMore: true, now: 1000 });

    const snapshot = service.snapshot();
    expect(snapshot.directories).toHaveLength(1);
    expect(snapshot.directories[0]).toMatchObject({
      directory: '/repo',
      cursor: 80,
      hasMore: true,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 1000,
    });
    expect(snapshot.directories[0].sessions).toHaveLength(20);
    expect(snapshot.directories[0].sessions[0].id).toBe('ses_0');
    service.close();
  });

  it('keeps runtime targets isolated in one Electron database', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: null, hasMore: false });

    runtimeRef.value = 'http://runtime-b.test';
    expect(service.snapshot().directories).toEqual([]);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_b', 11)], cursor: null, hasMore: false });
    expect(service.snapshot().directories[0].sessions[0].id).toBe('ses_b');

    runtimeRef.value = 'http://runtime-a.test';
    expect(service.snapshot().directories[0].sessions[0].id).toBe('ses_a');
    service.close();
  });

  it('replaces multiple directories in one transaction', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);

    service.replaceDirectories([
      { directory: '/repo/a', sessions: [session('ses_a', 10, '/repo/a')], cursor: null, hasMore: false },
      { directory: '/repo/b', sessions: [session('ses_b', 11, '/repo/b')], cursor: 9, hasMore: true },
    ], 1000);

    expect(service.snapshot().directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: '/repo/a', lastSyncedAt: 1000 }),
      expect.objectContaining({ directory: '/repo/b', cursor: 9, hasMore: true, lastSyncedAt: 1000 }),
    ]));
    service.close();
  });

  it('merges an SSE update without resetting page metadata', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: 8, hasMore: true, now: 1000 });

    service.upsert(session('ses_b', 11));

    expect(service.snapshot().directories[0]).toMatchObject({ cursor: 8, hasMore: true });
    expect(service.snapshot().directories[0].sessions.map((item) => item.id)).toEqual(['ses_b', 'ses_a']);
    service.close();
  });

  it('tracks incremental writes without advancing the last full reconciliation', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_a', 10)],
      cursor: 8,
      hasMore: true,
      now: 1000,
    });
    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_a', 10), session('ses_b', 11)],
      cursor: 8,
      hasMore: true,
      fullSync: false,
      now: 2000,
    });

    expect(service.snapshot().directories[0]).toMatchObject({
      lastSyncedAt: 2000,
      lastFullSyncedAt: 1000,
    });
    service.close();
  });

  it('rebuilds an incompatible cache schema instead of migrating it', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)] });
    service.close();

    const dbPath = path.join(tempDirectories[tempDirectories.length - 1], 'session-index.sqlite');
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(dbPath);
    db.prepare("UPDATE session_index_meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();

    const rebuilt = createSessionIndexService({
      dbPath,
      getRuntimeConfig: () => ({ apiBaseUrl: runtimeRef.value }),
    });
    expect(rebuilt.snapshot().directories).toEqual([]);
    rebuilt.close();
  });
});
