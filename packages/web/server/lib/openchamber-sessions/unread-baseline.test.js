import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUnreadBaseline, withUnreadBaseline } from './unread-baseline.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-unread-'));
  tempDirs.push(dir);
  return dir;
};

const filePath = (dataDir) => path.join(dataDir, 'sessions-unread.json');

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('createUnreadBaseline', () => {
  it('creates the baseline on the first read and keeps it across restarts', async () => {
    const dataDir = makeDataDir();
    expect(await createUnreadBaseline({ dataDir, now: () => 1000 }).get()).toBe(1000);
    expect(JSON.parse(fs.readFileSync(filePath(dataDir), 'utf8'))).toEqual({ since: 1000 });
    expect(await createUnreadBaseline({ dataDir, now: () => 9000 }).get()).toBe(1000);
  });

  it('leaves an unreadable file alone and answers unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dataDir = makeDataDir();
    fs.writeFileSync(filePath(dataDir), '{ broken');
    const baseline = createUnreadBaseline({ dataDir, now: () => 9000 });
    expect(await baseline.get()).toBeNull();
    expect(fs.readFileSync(filePath(dataDir), 'utf8')).toBe('{ broken');
  });

  it('retries a failed read instead of creating a new baseline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dataDir = makeDataDir();
    fs.writeFileSync(filePath(dataDir), JSON.stringify({ since: 500 }));
    let fail = true;
    const fsPromises = {
      ...fs.promises,
      readFile: (...args) => (fail ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : fs.promises.readFile(...args)),
    };
    const baseline = createUnreadBaseline({ dataDir, fsPromises, now: () => 9000 });
    expect(await baseline.get()).toBeNull();
    fail = false;
    expect(await baseline.get()).toBe(500);
  });

  it('serves its baseline even when the file cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fsPromises = {
      ...fs.promises,
      writeFile: () => Promise.reject(new Error('read-only')),
    };
    const baseline = createUnreadBaseline({ dataDir: makeDataDir(), fsPromises, now: () => 1000 });
    expect(await baseline.get()).toBe(1000);
  });
});

describe('withUnreadBaseline', () => {
  const session = (time) => ({ id: 'ses_a', time: { created: 1, updated: 1, ...time } });

  it('serves a turn that ended before the baseline as seen', () => {
    expect(withUnreadBaseline(session({ idle: 100 }), 500).time.viewed).toBe(100);
    expect(withUnreadBaseline(session({ idle: 100, viewed: 50 }), 500).time.viewed).toBe(100);
    expect(withUnreadBaseline(session({ idle: 500 }), 500).time.viewed).toBe(500);
  });

  it('leaves later turns, seen turns and sessions without a turn as they are', () => {
    const later = session({ idle: 600, viewed: 50 });
    expect(withUnreadBaseline(later, 500)).toBe(later);
    const seen = session({ idle: 100, viewed: 100 });
    expect(withUnreadBaseline(seen, 500)).toBe(seen);
    const fresh = session({});
    expect(withUnreadBaseline(fresh, 500)).toBe(fresh);
    expect(withUnreadBaseline(null, 500)).toBeNull();
  });
});
