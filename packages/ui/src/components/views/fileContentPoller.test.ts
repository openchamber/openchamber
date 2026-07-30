import { describe, expect, test } from 'bun:test';

import { createFileContentPoller } from './fileContentPoller';

const MAX_BYTES = 200_000;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('createFileContentPoller', () => {
  test('does not reload unchanged content across repeated metadata false positives (issue #1489)', async () => {
    let reads = 0;
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: async () => {
        reads += 1;
        return 'same content';
      },
      getLoadedContent: () => 'same content',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    expect(await poller.poll(12)).toBe(true);
    expect(await poller.poll(12)).toBe(true);

    expect(reads).toBe(2);
    expect(applied).toEqual([]);
  });

  test('reports a failed read as unobserved instead of unchanged', async () => {
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: async () => { throw new Error('read failed'); },
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    expect(await poller.poll(6)).toBe(false);
    expect(applied).toEqual([]);
  });

  test('reports a dirty buffer as unobserved', async () => {
    let reads = 0;
    const poller = createFileContentPoller({
      readContent: async () => {
        reads += 1;
        return 'external edit';
      },
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => true,
      applyContent: () => undefined,
      maxBytes: MAX_BYTES,
    });

    expect(await poller.poll(6)).toBe(false);
    expect(reads).toBe(0);
  });

  test('reloads a same-size edit even when metadata cannot distinguish it', async () => {
    let reads = 0;
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: async () => {
        reads += 1;
        return 'abd';
      },
      getLoadedContent: () => 'abc',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    expect(await poller.poll(3)).toBe(true);

    expect(reads).toBe(2);
    expect(applied).toEqual(['abd']);
  });

  test('does not overwrite a buffer that becomes dirty while polling', async () => {
    const read = deferred<string>();
    let dirty = false;
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: () => read.promise,
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => dirty,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    const polling = poller.poll(20);
    dirty = true;
    read.resolve('external edit');
    await polling;

    expect(applied).toEqual([]);
  });

  test('does not apply a transient read that changes during polling', async () => {
    const reads = ['partial', 'settled', 'settled', 'settled'];
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: async () => reads.shift() ?? 'settled',
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    await poller.poll(7);
    expect(applied).toEqual([]);

    expect(await poller.poll(7)).toBe(true);
    expect(applied).toEqual(['settled']);
  });

  test('allows only one read in flight and ignores a disposed poll', async () => {
    const read = deferred<string>();
    let reads = 0;
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: () => {
        reads += 1;
        return read.promise;
      },
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    const first = poller.poll(5);
    await poller.poll(5);
    poller.dispose();
    read.resolve('after');
    await first;

    expect(reads).toBe(1);
    expect(applied).toEqual([]);
  });

  test('does not overwrite after an ABA save during the confirmation read', async () => {
    const firstRead = deferred<string>();
    const secondRead = deferred<string>();
    let reads = 0;
    let loadedRevision = 0;
    const applied: string[] = [];
    const poller = createFileContentPoller({
      readContent: () => ++reads === 1 ? firstRead.promise : secondRead.promise,
      getLoadedContent: () => 'before',
      getLoadedRevision: () => loadedRevision,
      isDirty: () => false,
      applyContent: (content) => applied.push(content),
      maxBytes: MAX_BYTES,
    });

    const polling = poller.poll(20);
    firstRead.resolve('external edit');
    await Promise.resolve();
    loadedRevision += 1;
    secondRead.resolve('external edit');
    await polling;

    expect(reads).toBe(2);
    expect(applied).toEqual([]);
  });

  test('does not read content above the polling byte limit', async () => {
    let reads = 0;
    const poller = createFileContentPoller({
      readContent: async () => {
        reads += 1;
        return 'content';
      },
      getLoadedContent: () => 'before',
      getLoadedRevision: () => 0,
      isDirty: () => false,
      applyContent: () => undefined,
      maxBytes: MAX_BYTES,
    });

    expect(await poller.poll(MAX_BYTES + 1)).toBe(false);

    expect(reads).toBe(0);
  });
});
