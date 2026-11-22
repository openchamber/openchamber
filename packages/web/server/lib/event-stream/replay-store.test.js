import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { createReplayStore, MAX_REPLAY_FILE_BYTES, resolveGlobalReplayFilePath } from './replay-store.js';

const directories = [];
const tempFile = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'openchamber-replay-'));
  directories.push(directory);
  return path.join(directory, 'global-replay.jsonl');
};

const entry = (position, upstream = '', now = 1_000) => ({
  position,
  upstream,
  eventId: `local-${position}`,
  serializedFrame: JSON.stringify({ type: 'event', eventId: `occ1.global.${position}.${upstream}` }),
  bytes: 10,
  committedAt: now,
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('replay store', () => {
  it('accepts the byte limit and rejects an oversized file without changing it', () => {
    const filePath = tempFile();
    const record = '{"v":1,"t":"head","p":7,"u":"cursor"}\n';
    writeFileSync(filePath, record + ' '.repeat(MAX_REPLAY_FILE_BYTES - Buffer.byteLength(record)));
    expect(createReplayStore({ filePath }).load().head.position).toBe(7);
    writeFileSync(filePath, record + ' '.repeat(MAX_REPLAY_FILE_BYTES - Buffer.byteLength(record) + 1));
    const warnings = [];
    const store = createReplayStore({ filePath, warn: (message) => warnings.push(message), compactAfterRecords: 1 });
    expect(store.load().head.position).toBe(0);
    store.appendHead({ position: 1, upstream: '' });
    expect(readFileSync(filePath).length).toBe(MAX_REPLAY_FILE_BYTES + 1);
    expect(warnings).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking on load or later writes', () => {
    const filePath = tempFile();
    execFileSync('mkfifo', [filePath]);
    const moduleUrl = new URL('./replay-store.js', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createReplayStore } from ${JSON.stringify(moduleUrl)};
      const warnings = [];
      const store = createReplayStore({ filePath: ${JSON.stringify(filePath)}, warn: (message) => warnings.push(message), compactAfterRecords: 1 });
      if (store.load().head.position !== 0) throw new Error('unexpected head');
      store.appendHead({ position: 1, upstream: '' });
      if (warnings.length !== 1) throw new Error('expected warning');
    `], { timeout: 3000 });
  });

  it('repairs a malformed middle record before appending and survives restart', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{"t":"head","p":1}\ninvalid\n{"t":"head","p":99}\n');
    const warnings = [];
    const store = createReplayStore({ filePath, compactAfterRecords: 3, warn: (message) => warnings.push(message) });
    expect(store.load().head.position).toBe(1);
    store.appendHead({ position: 2, upstream: '' });
    expect(createReplayStore({ filePath }).load().head.position).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('repairs a valid final record without a newline before appending', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{"t":"head","p":1}');
    const store = createReplayStore({ filePath });
    store.load();
    store.appendHead({ position: 2, upstream: '' });
    expect(createReplayStore({ filePath }).load().head.position).toBe(2);
  });

  it('counts accepted UTF-8 bytes rather than characters for compaction', () => {
    const filePath = tempFile();
    const line = '{"t":"head","p":1,"u":"é"}\n';
    const appended = '{"v":1,"t":"head","p":2,"u":""}\n';
    writeFileSync(filePath, line);
    const store = createReplayStore({ filePath, compactAfterBytes: Buffer.byteLength(line + appended), warn: () => {} });
    store.load();
    store.appendHead({ position: 2, upstream: '' });
    expect(JSON.parse(readFileSync(filePath, 'utf8')).t).toBe('snapshot');
  });

  it('round-trips local frames, the head and a trim through the file', () => {
    const filePath = tempFile();
    const first = createReplayStore({ filePath });
    first.load();
    first.appendLocal(entry(2, 'inst-a:1'));
    first.appendHead({ position: 3, upstream: 'inst-a:2' });
    first.appendTrim(1);

    const second = createReplayStore({ filePath });
    const state = second.load();
    expect(state.head).toEqual({ position: 3, upstream: 'inst-a:2' });
    expect(state.entries).toEqual([entry(2, 'inst-a:1')]);
    expect(state.droppedLocalThroughPosition).toBe(1);
  });

  it('drops the entries a later reset forbids replaying', () => {
    const filePath = tempFile();
    const first = createReplayStore({ filePath });
    first.load();
    first.appendLocal(entry(2, 'inst-a:1'));
    first.appendReset({ position: 4, upstream: 'inst-b:0' });

    const state = createReplayStore({ filePath }).load();
    expect(state.head).toEqual({ position: 4, upstream: 'inst-b:0' });
    expect(state.entries).toEqual([]);
    expect(state.droppedLocalThroughPosition).toBe(4);
  });

  it('ignores a torn final record, as a killed process leaves it', () => {
    const filePath = tempFile();
    const store = createReplayStore({ filePath });
    store.load();
    store.appendLocal(entry(2, 'inst-a:1'));
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{"v":1,"t":"local","entry":{"position":`);

    const restarted = createReplayStore({ filePath });
    const state = restarted.load();
    expect(state.entries).toEqual([entry(2, 'inst-a:1')]);
    expect(state.head).toEqual({ position: 2, upstream: 'inst-a:1' });
    restarted.appendHead({ position: 3, upstream: 'inst-a:2' });
    expect(createReplayStore({ filePath }).load().head.position).toBe(3);
  });

  it('does not accumulate records on repeated loads', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{"t":"head","p":1}\n');
    const store = createReplayStore({ filePath, compactAfterRecords: 3 });
    store.load();
    store.load();
    store.appendHead({ position: 2, upstream: '' });
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('compacts the append log into a snapshot and still reloads it', () => {
    const filePath = tempFile();
    const store = createReplayStore({ filePath, compactAfterRecords: 2 });
    store.load();
    store.appendLocal(entry(2, 'inst-a:1'));
    store.appendHead({ position: 3, upstream: 'inst-a:2' });
    store.appendLocal(entry(4, 'inst-a:3'));

    const lines = readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.at(-1).t).toBe('snapshot');
    const state = createReplayStore({ filePath }).load();
    expect(state.head).toEqual({ position: 4, upstream: 'inst-a:3' });
    expect(state.entries.map((item) => item.position)).toEqual([2, 4]);
  });

  it('does not advance durable state past a failed append, and lands the failed frame first on recovery (#2111)', () => {
    const filePath = tempFile();
    const warnings = [];
    const store = createReplayStore({ filePath, warn: (message) => warnings.push(message) });
    store.load();
    expect(store.appendLocal(entry(1, 'inst-a:0'))).toBe(true);

    // Break appends deterministically, root-proof: the store file becomes
    // a directory, so appendFileSync fails with EISDIR. (The injection
    // replaces the file, so entry 1 is lost with it — that is the
    // injection's doing, not the store's. The invariant under test: the
    // persisted head may never claim a position past the failed frame.)
    rmSync(filePath);
    mkdirSync(filePath);
    expect(store.appendLocal(entry(2, 'inst-a:1'))).toBe(false);
    expect(store.state().entries.map((item) => item.position)).toEqual([1]);
    expect(store.state().head.position).toBe(1);
    // A later head write is refused too, and does not advance in memory.
    expect(store.appendHead({ position: 3, upstream: 'inst-a:2' })).toBe(false);
    expect(store.state().head.position).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);

    // Recovery: the queued frame lands before the head that follows it.
    rmSync(filePath, { recursive: true, force: true });
    expect(store.appendHead({ position: 3, upstream: 'inst-a:2' })).toBe(true);
    const state = createReplayStore({ filePath }).load();
    expect(state.head).toEqual({ position: 3, upstream: 'inst-a:2' });
    expect(state.entries.map((item) => item.position)).toEqual([2]);
  });

  it('keeps in-memory-only stores committing without a persistence path (#2111)', () => {
    const store = createReplayStore();
    store.load();
    expect(store.appendLocal(entry(2, 'inst-a:1'))).toBe(true);
    expect(store.appendHead({ position: 3, upstream: 'inst-a:2' })).toBe(true);
    const state = store.state();
    expect(state.head).toEqual({ position: 3, upstream: 'inst-a:2' });
    expect(state.entries.map((item) => item.position)).toEqual([2]);
  });

  it('uses OPENCHAMBER_DATA_DIR for the global stream file', () => {
    expect(resolveGlobalReplayFilePath({ OPENCHAMBER_DATA_DIR: '/tmp/oc-data' }, '/home/me'))
      .toBe('/tmp/oc-data/event-stream/global-replay.jsonl');
    expect(resolveGlobalReplayFilePath({}, '/home/me'))
      .toBe('/home/me/.config/openchamber/event-stream/global-replay.jsonl');
  });
});
