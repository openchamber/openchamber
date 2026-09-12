import { describe, expect, test } from 'bun:test';

import { readMobileBrowserSelection, saveMobileBrowserSelection } from './mobileBrowserSelection';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
};

const scope = { runtimeKey: 'server-a', directory: '/project' };
const selection = { sessionId: 'session-a', serverTargetId: 'target-a' };

describe('mobile browser selection', () => {
  test('restores the genuine server session and target when reopening the same project', () => {
    const storage = createStorage();
    saveMobileBrowserSelection(scope, selection, storage);

    const restored = readMobileBrowserSelection(scope, storage);

    expect(restored).toEqual(selection);
  });

  test('keeps identical project paths on different servers separate', () => {
    const storage = createStorage();
    saveMobileBrowserSelection(scope, selection, storage);

    const restored = readMobileBrowserSelection({ ...scope, runtimeKey: 'server-b' }, storage);

    expect(restored).toBeNull();
  });

  test('keeps different project directories on the same server separate', () => {
    const storage = createStorage();
    saveMobileBrowserSelection(scope, selection, storage);

    const restored = readMobileBrowserSelection({ ...scope, directory: '/another-project' }, storage);

    expect(restored).toBeNull();
  });

  test('remembers a later target selection without changing another project', () => {
    const storage = createStorage();
    const otherScope = { ...scope, directory: '/other' };
    saveMobileBrowserSelection(scope, selection, storage);
    saveMobileBrowserSelection(otherScope, selection, storage);

    saveMobileBrowserSelection(scope, { ...selection, serverTargetId: 'target-b' }, storage);

    expect(readMobileBrowserSelection(scope, storage)?.serverTargetId).toBe('target-b');
    expect(readMobileBrowserSelection(otherScope, storage)?.serverTargetId).toBe('target-a');
  });

  for (const raw of [
    '{invalid',
    JSON.stringify({ sessionId: 'session-a' }),
    JSON.stringify({ sessionId: '', serverTargetId: 'target-a' }),
    JSON.stringify({ sessionId: 'session-a', serverTargetId: 7 }),
    JSON.stringify(null),
  ]) {
    test(`ignores malformed persisted selection ${raw}`, () => {
      const storage = { getItem: () => raw };

      const restored = readMobileBrowserSelection(scope, storage);

      expect(restored).toBeNull();
    });
  }
});
