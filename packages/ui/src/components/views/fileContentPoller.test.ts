import { describe, expect, test } from 'bun:test';

import { createFileContentPoller } from './fileContentPoller';

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
    });

    expect(await poller.poll()).toBe(true);
    expect(await poller.poll()).toBe(true);

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
    });

    expect(await poller.poll()).toBe(false);
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
    });

    expect(await poller.poll()).toBe(false);
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
    });

    expect(await poller.poll()).toBe(true);

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
    });

    const polling = poller.poll();
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
    });

    await poller.poll();
    expect(applied).toEqual([]);

    expect(await poller.poll()).toBe(true);
    expect(applied).toEqual(['settled']);
  });

  test('ignores a read that resolves after dispose', async () => {
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
    });

    const pending = poller.poll();
    poller.dispose();
    read.resolve('after');
    expect(await pending).toBe(false);

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
    });

    const polling = poller.poll();
    firstRead.resolve('external edit');
    await Promise.resolve();
    loadedRevision += 1;
    secondRead.resolve('external edit');
    await polling;

    expect(reads).toBe(2);
    expect(applied).toEqual([]);
  });

});
