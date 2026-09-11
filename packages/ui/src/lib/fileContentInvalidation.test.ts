import { describe, expect, test } from 'bun:test';

import {
  notifyFileContentInvalidated,
  subscribeToFileContentInvalidation,
} from './fileContentInvalidation';

describe('fileContentInvalidation', () => {
  test('publishes normalized paths within the captured runtime', () => {
    const received: Array<{ runtimeKey: string; paths: readonly string[] }> = [];
    const unsubscribe = subscribeToFileContentInvalidation((invalidation) => {
      received.push(invalidation);
    });

    notifyFileContentInvalidated({
      runtimeKey: ' runtime-a ',
      paths: [' /repo/a.txt ', '/repo/a.txt', '', '/repo/b.txt'],
    });
    unsubscribe();

    expect(received).toEqual([{
      runtimeKey: 'runtime-a',
      paths: ['/repo/a.txt', '/repo/b.txt'],
    }]);
  });

  test('stops publishing after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeToFileContentInvalidation(() => {
      calls += 1;
    });
    unsubscribe();

    notifyFileContentInvalidated({ runtimeKey: 'runtime-a', paths: ['/repo/a.txt'] });

    expect(calls).toBe(0);
  });
});
