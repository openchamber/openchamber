import { afterEach, describe, expect, it, vi } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRevokedSessions } from './revoked-sessions.js';

describe('revocation durability', () => {
  const directories = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('flushes file before rename and directory after rename', async () => {
    // Given a real temporary filesystem with instrumented handles.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revoked-durability-'));
    directories.push(directory);
    const file = path.join(directory, 'revocations.json');
    const store = createRevokedSessions(file);
    const events = [];
    const open = fs.promises.open.bind(fs.promises);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push(args[0] === directory ? 'directory-sync' : 'file-sync');
        return sync();
      });
      return handle;
    });
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      events.push('rename');
      return rename(...args);
    });
    // When a revocation is persisted.
    await store.revoke('synthetic-token', Date.now() + 60_000);
    // Then durable ordering includes both flushes.
    expect(events).toEqual(['file-sync', 'rename', 'directory-sync']);
  });

  it('preserves disk and memory when the temporary file cannot be flushed', async () => {
    // Given an existing valid list and a filesystem flush failure.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revoked-flush-failure-'));
    directories.push(directory);
    const file = path.join(directory, 'revocations.json');
    const raw = JSON.stringify({ version: 1, revoked: [] });
    fs.writeFileSync(file, raw);
    const store = createRevokedSessions(file);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('synthetic flush failure'));
      return handle;
    });
    // When durability cannot be established, then no revocation is committed.
    await expect(store.revoke('synthetic-token', Date.now() + 60_000)).rejects.toThrow('synthetic flush failure');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(store.has('synthetic-token')).toBe(false);
    expect(fs.readdirSync(directory)).toEqual(['revocations.json']);
  });
});
