import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_INPUT_HISTORY_LIMIT,
  DEFAULT_INPUT_HISTORY_SCOPE,
  isInputHistoryLimit,
  isInputHistoryScope,
} from '@/lib/inputHistoryScope';
import type { AttachedFile } from '@/stores/types/sessionTypes';

const STORAGE_KEY = 'openchamber-input-history.v1';

const importStoreModule = async (): Promise<typeof import('./useInputHistoryStore')> => (
  import(`./useInputHistoryStore.ts?test=${Date.now()}-${Math.random()}`)
);

const createFakeStorage = (): Storage => {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  return storage;
};

const createQuotaStorage = (maxEntriesPerBucket: number): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      // SAFETY: this test storage only reads back envelopes that this suite serialized.
      const parsed = JSON.parse(String(value)) as {
        global?: Record<string, { entries?: unknown[] }>;
        session?: Record<string, { entries?: unknown[] }>;
      };
      const counts = [
        ...Object.values(parsed.global ?? {}).map((bucket) => bucket.entries?.length ?? 0),
        ...Object.values(parsed.session ?? {}).map((bucket) => bucket.entries?.length ?? 0),
      ];
      if (counts.some((count) => count > maxEntriesPerBucket)) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
};

const installWindow = (localStorage: Storage): void => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage,
      addEventListener: () => {},
    },
  });
};

const makeAttachment = (overrides: Partial<AttachedFile> = {}): AttachedFile => ({
  id: overrides.id ?? 'attachment',
  file: overrides.file ?? new File([], overrides.filename ?? 'note.txt', { type: overrides.mimeType ?? 'text/plain' }),
  dataUrl: overrides.dataUrl ?? 'data:text/plain;base64,Zm9v',
  mimeType: overrides.mimeType ?? 'text/plain',
  filename: overrides.filename ?? 'note.txt',
  size: overrides.size ?? 3,
  source: overrides.source ?? 'local',
  serverPath: overrides.serverPath,
  vscodePath: overrides.vscodePath,
  vscodeSource: overrides.vscodeSource,
  sourceDocumentId: overrides.sourceDocumentId,
});

describe('useInputHistoryStore', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const restoreWindow = (): void => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
      return;
    }
    Reflect.deleteProperty(globalThis, 'window');
  };

  beforeEach(() => {
    restoreWindow();
  });

  afterEach(() => {
    restoreWindow();
  });

  test('uses defaults when the persisted envelope is missing', async () => {
    const localStorage = createFakeStorage();
    installWindow(localStorage);

    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');

    expect(identity).not.toBeNull();
    expect(DEFAULT_INPUT_HISTORY_SCOPE).toBe('session');
    expect(DEFAULT_INPUT_HISTORY_LIMIT).toBe(40);
    expect(mod.useInputHistoryStore.getState().scope).toBe('session');
    expect(mod.useInputHistoryStore.getState().entryLimit).toBe(DEFAULT_INPUT_HISTORY_LIMIT);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity!)).toEqual([]);
  });

  test('treats omitted persisted maps as empty maps', async () => {
    const localStorage = createFakeStorage();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scope: 'session' }));
    installWindow(localStorage);

    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');

    expect(identity).not.toBeNull();
    expect(mod.useInputHistoryStore.getState().scope).toBe('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity!)).toEqual([]);
    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity!)).toEqual([]);
  });

  test('drops malformed persisted siblings but preserves valid namespaces and entries', async () => {
    const localStorage = createFakeStorage();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      scope: 'session',
      global: {
        [JSON.stringify(['runtime-a'])]: {
          touchedAt: 10,
          entries: [
            {
              text: 'kept',
              attachmentKeys: ['text/plain|kept.txt|1|data'],
              restorableAttachments: [],
              submittedAt: 1,
            },
            {
              text: 42,
              attachmentKeys: [],
              restorableAttachments: [],
              submittedAt: 2,
            },
          ],
        },
        [JSON.stringify(['runtime-b', ''])]: {
          touchedAt: 20,
          entries: [],
        },
      },
      session: {
        [JSON.stringify(['runtime-a', '/repo', 'session-1'])]: {
          touchedAt: 11,
          entries: [
            {
              text: 'session-kept',
              attachmentKeys: [],
              restorableAttachments: [
                {
                  key: 'vscode|file.ts|text/plain|10|/repo/file.ts',
                  source: 'vscode-file',
                  filename: 'file.ts',
                  mimeType: 'text/plain',
                  size: 10,
                  reference: '/repo/file.ts',
                },
              ],
              submittedAt: 3,
            },
          ],
        },
        [JSON.stringify(['runtime-a', '/repo'])]: {
          touchedAt: 12,
          entries: [],
        },
      },
    }));
    installWindow(localStorage);

    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo/', 'session-1');

    expect(identity).not.toBeNull();
    expect(mod.useInputHistoryStore.getState().scope).toBe('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity!)).toEqual([
      {
        text: 'session-kept',
        attachmentKeys: [],
        restorableAttachments: [
          {
            key: 'vscode|file.ts|text/plain|10|/repo/file.ts',
            source: 'vscode-file',
            filename: 'file.ts',
            mimeType: 'text/plain',
            size: 10,
            reference: '/repo/file.ts',
          },
        ],
        submittedAt: 3,
      },
    ]);
    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity!)).toEqual([
      {
        text: 'kept',
        attachmentKeys: ['text/plain|kept.txt|1|data'],
        restorableAttachments: [],
        submittedAt: 1,
      },
    ]);
  });

  test('validates scope, limit, runtime, directory, and session identity inputs', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();

    expect(isInputHistoryScope('global')).toBe(true);
    expect(isInputHistoryScope('session')).toBe(true);
    expect(isInputHistoryScope('other')).toBe(false);
    expect(isInputHistoryLimit(1)).toBe(true);
    expect(isInputHistoryLimit(40)).toBe(true);
    expect(isInputHistoryLimit(100)).toBe(true);
    expect(isInputHistoryLimit(0)).toBe(false);
    expect(isInputHistoryLimit(101)).toBe(false);
    expect(isInputHistoryLimit(1.5)).toBe(false);
    expect(isInputHistoryLimit(Number.NaN)).toBe(false);
    expect(mod.createInputHistoryIdentity('', '/repo', 'session-1')).toBeNull();
    expect(mod.createInputHistoryIdentity('runtime-a', '   ', 'session-1')).toBeNull();
    expect(mod.createInputHistoryIdentity('runtime-a', '/repo', '')).toBeNull();
    expect(mod.createInputHistoryIdentity('runtime-a', '/repo/', 'session-1')).toEqual({
      runtimeKey: 'runtime-a',
      directory: '/repo',
      sessionId: 'session-1',
    });
  });

  test('serializes only restorable attachment references and bounds attachment keys', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();

    const submission = mod.createInputHistorySubmission('hello', [
      makeAttachment({
        id: 'server-file',
        source: 'server',
        filename: 'server.ts',
        mimeType: 'text/plain',
        size: 12,
        dataUrl: 'file:///repo/server.ts',
        serverPath: '/repo/server.ts',
      }),
      makeAttachment({
        id: 'vscode-file',
        source: 'vscode',
        filename: 'editor.ts',
        mimeType: 'text/plain',
        size: 8,
        dataUrl: 'file:///repo/editor.ts',
        vscodePath: '/repo/editor.ts',
        vscodeSource: 'file',
      }),
      makeAttachment({
        id: 'data-url',
        source: 'local',
        filename: 'inline.txt',
        mimeType: 'text/plain',
        size: 4,
        dataUrl: 'data:text/plain;base64,aGV5',
      }),
      makeAttachment({
        id: 'http-query',
        source: 'local',
        filename: 'signed.png',
        mimeType: 'image/png',
        size: 5,
        dataUrl: 'https://cdn.example.com/file.png?token=secret',
      }),
      makeAttachment({
        id: 'http-clean',
        source: 'local',
        filename: 'clean.png',
        mimeType: 'image/png',
        size: 6,
        dataUrl: 'https://cdn.example.com/file.png',
      }),
    ]);

    expect(submission.text).toBe('hello');
    expect(submission.attachmentKeys).toHaveLength(5);
    expect(submission.restorableAttachments).toEqual([
      {
        key: 'server|server.ts|text/plain|12|file:///repo/server.ts',
        source: 'file-url',
        filename: 'server.ts',
        mimeType: 'text/plain',
        size: 12,
        reference: 'file:///repo/server.ts',
      },
      {
        key: 'vscode|editor.ts|text/plain|8|/repo/editor.ts',
        source: 'vscode-file',
        filename: 'editor.ts',
        mimeType: 'text/plain',
        size: 8,
        reference: '/repo/editor.ts',
      },
      {
        key: 'local|clean.png|image/png|6|https://cdn.example.com/file.png',
        source: 'file-url',
        filename: 'clean.png',
        mimeType: 'image/png',
        size: 6,
        reference: 'https://cdn.example.com/file.png',
      },
    ]);
  });

  test('appends every submission to both scope buckets', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(identity, [
      mod.createInputHistorySubmission('hello', []),
    ]);

    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity)).toHaveLength(1);
    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity)).toHaveLength(1);
  });

  test('suppresses adjacent duplicates per bucket without affecting sibling buckets', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const first = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    const second = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-2');
    if (!first || !second) throw new Error('identity missing');

    const submission = mod.createInputHistorySubmission('repeat', []);
    mod.useInputHistoryStore.getState().appendSubmissions(first, [submission]);
    mod.useInputHistoryStore.getState().appendSubmissions(second, [submission]);

    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['repeat']);
    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['repeat']);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), second).map((entry) => entry.text)).toEqual(['repeat']);
  });

  test('keeps non-adjacent duplicates', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(identity, [
      mod.createInputHistorySubmission('first', []),
      mod.createInputHistorySubmission('middle', []),
      mod.createInputHistorySubmission('first', []),
    ]);

    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity).map((entry) => entry.text)).toEqual([
      'first',
      'middle',
      'first',
    ]);
  });

  test('caps each namespace at forty entries', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(identity, Array.from({ length: 45 }, (_, index) => (
      mod.createInputHistorySubmission(`entry-${index}`, [])
    )));

    const entries = mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity);
    expect(entries).toHaveLength(40);
    expect(entries[0]?.text).toBe('entry-5');
    expect(entries.at(-1)?.text).toBe('entry-44');
  });

  test('preserves a persisted entry limit above forty at startup', async () => {
    const localStorage = createFakeStorage();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      scope: 'global',
      entryLimit: 100,
      global: {
        [JSON.stringify(['runtime-a'])]: {
          touchedAt: 10,
          entries: Array.from({ length: 45 }, (_, index) => ({
            text: `entry-${index}`,
            attachmentKeys: [],
            restorableAttachments: [],
            submittedAt: index + 1,
          })),
        },
      },
      session: {},
    }));
    installWindow(localStorage);

    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    expect(mod.useInputHistoryStore.getState().entryLimit).toBe(100);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity)).toHaveLength(45);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity)[0]?.text).toBe('entry-0');
  });

  test('applies a lower entry limit immediately to global and session buckets', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const first = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    const second = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-2');
    if (!first || !second) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(first, Array.from({ length: 4 }, (_, index) => (
      mod.createInputHistorySubmission(`first-${index}`, [])
    )));
    mod.useInputHistoryStore.getState().appendSubmissions(second, [
      mod.createInputHistorySubmission('second-0', []),
      mod.createInputHistorySubmission('second-1', []),
    ]);

    mod.useInputHistoryStore.getState().applyEntryLimit(2);

    expect(mod.useInputHistoryStore.getState().entryLimit).toBe(2);
    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual([
      'second-0',
      'second-1',
    ]);
    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual([
      'first-2',
      'first-3',
    ]);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), second).map((entry) => entry.text)).toEqual([
      'second-0',
      'second-1',
    ]);
  });

  test('ignores invalid entry limits without mutating history', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(identity, [
      mod.createInputHistorySubmission('kept-0', []),
      mod.createInputHistorySubmission('kept-1', []),
    ]);

    mod.useInputHistoryStore.getState().applyEntryLimit(0);

    expect(mod.useInputHistoryStore.getState().entryLimit).toBe(DEFAULT_INPUT_HISTORY_LIMIT);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), identity).map((entry) => entry.text)).toEqual([
      'kept-0',
      'kept-1',
    ]);
  });

  test('keeps only the eight most recent global namespaces', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();

    for (let index = 0; index < 9; index += 1) {
      const identity = mod.createInputHistoryIdentity(`runtime-${index}`, `/repo-${index}`, 'session-1');
      if (!identity) throw new Error('identity missing');
      mod.useInputHistoryStore.getState().appendSubmissions(identity, [
        mod.createInputHistorySubmission(`entry-${index}`, []),
      ]);
    }

    const dropped = mod.createInputHistoryIdentity('runtime-0', '/repo-0', 'session-1');
    const kept = mod.createInputHistoryIdentity('runtime-8', '/repo-8', 'session-1');
    if (!dropped || !kept) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), dropped)).toEqual([]);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), kept).map((entry) => entry.text)).toEqual(['entry-8']);
  });

  test('shares one global bucket across directories in the same runtime', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const first = mod.createInputHistoryIdentity('runtime-a', '/repo-a', 'session-1');
    const second = mod.createInputHistoryIdentity('runtime-a', '/repo-b', 'session-2');
    if (!first || !second) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(first, [mod.createInputHistorySubmission('first', [])]);
    mod.useInputHistoryStore.getState().appendSubmissions(second, [mod.createInputHistorySubmission('second', [])]);

    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['first', 'second']);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), second).map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  test('keeps only the fifty most recent session namespaces', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();

    for (let index = 0; index < 51; index += 1) {
      const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', `session-${index}`);
      if (!identity) throw new Error('identity missing');
      mod.useInputHistoryStore.getState().appendSubmissions(identity, [
        mod.createInputHistorySubmission(`entry-${index}`, []),
      ]);
    }

    const dropped = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-0');
    const kept = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-50');
    if (!dropped || !kept) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), dropped)).toEqual([]);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), kept).map((entry) => entry.text)).toEqual(['entry-50']);
  });

  test('selects global or session history according to the current scope', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const first = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    const second = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-2');
    if (!first || !second) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(first, [mod.createInputHistorySubmission('first', [])]);
    mod.useInputHistoryStore.getState().appendSubmissions(second, [mod.createInputHistorySubmission('second', [])]);

    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['first', 'second']);
    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['first']);
  });

  test('clears only the targeted session namespace', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();
    const deleted = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    const retained = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-2');
    if (!deleted || !retained) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().appendSubmissions(deleted, [mod.createInputHistorySubmission('deleted', [])]);
    mod.useInputHistoryStore.getState().appendSubmissions(retained, [mod.createInputHistorySubmission('retained', [])]);

    mod.useInputHistoryStore.getState().clearSession(deleted);

    mod.useInputHistoryStore.getState().applyScope('session');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), deleted)).toEqual([]);
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), retained).map((entry) => entry.text)).toEqual(['retained']);
    mod.useInputHistoryStore.getState().applyScope('global');
    expect(mod.selectInputHistoryEntries(mod.useInputHistoryStore.getState(), deleted).map((entry) => entry.text)).toEqual([
      'deleted',
      'retained',
    ]);
  });

  test('stale tab append preserves history written by another tab', async () => {
    const localStorage = createFakeStorage();
    installWindow(localStorage);
    const tabA = await importStoreModule();
    const tabB = await importStoreModule();
    const first = tabA.createInputHistoryIdentity('runtime-a', '/repo', 'session-a');
    const second = tabB.createInputHistoryIdentity('runtime-a', '/repo', 'session-b');
    if (!first || !second) throw new Error('identity missing');

    tabA.useInputHistoryStore.getState().appendSubmissions(first, [
      tabA.createInputHistorySubmission('from A', []),
    ]);
    tabB.useInputHistoryStore.getState().appendSubmissions(second, [
      tabB.createInputHistorySubmission('from B', []),
    ]);

    const observer = await importStoreModule();
    observer.useInputHistoryStore.getState().applyScope('global');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual([
      'from A',
      'from B',
    ]);
    observer.useInputHistoryStore.getState().applyScope('session');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual(['from A']);
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), second).map((entry) => entry.text)).toEqual(['from B']);
  });

  test('stale tab append uses the newest durable entry limit', async () => {
    const localStorage = createFakeStorage();
    installWindow(localStorage);
    const tabA = await importStoreModule();
    const tabB = await importStoreModule();
    const identity = tabA.createInputHistoryIdentity('runtime-a', '/repo', 'session-a');
    if (!identity) throw new Error('identity missing');

    tabB.useInputHistoryStore.getState().applyEntryLimit(2);
    tabA.useInputHistoryStore.getState().appendSubmissions(identity, Array.from({ length: 5 }, (_, index) => (
      tabA.createInputHistorySubmission(`entry-${index}`, [])
    )));

    const observer = await importStoreModule();
    expect(observer.useInputHistoryStore.getState().entryLimit).toBe(2);
    observer.useInputHistoryStore.getState().applyScope('session');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), identity).map((entry) => entry.text)).toEqual([
      'entry-3',
      'entry-4',
    ]);
  });

  test('stale tab scope change preserves newer history buckets', async () => {
    const localStorage = createFakeStorage();
    installWindow(localStorage);
    const tabA = await importStoreModule();
    const first = tabA.createInputHistoryIdentity('runtime-a', '/repo', 'session-a');
    if (!first) throw new Error('identity missing');
    tabA.useInputHistoryStore.getState().appendSubmissions(first, [
      tabA.createInputHistorySubmission('from A', []),
    ]);

    const tabB = await importStoreModule();
    const second = tabB.createInputHistoryIdentity('runtime-a', '/repo', 'session-b');
    if (!second) throw new Error('identity missing');
    tabB.useInputHistoryStore.getState().appendSubmissions(second, [
      tabB.createInputHistorySubmission('from B', []),
    ]);

    tabA.useInputHistoryStore.getState().applyScope('session');

    const observer = await importStoreModule();
    expect(observer.useInputHistoryStore.getState().scope).toBe('session');
    observer.useInputHistoryStore.getState().applyScope('global');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), first).map((entry) => entry.text)).toEqual([
      'from A',
      'from B',
    ]);
    observer.useInputHistoryStore.getState().applyScope('session');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), second).map((entry) => entry.text)).toEqual(['from B']);
  });

  test('stale tab cleanup deletes only its target from newer history', async () => {
    const localStorage = createFakeStorage();
    installWindow(localStorage);
    const tabA = await importStoreModule();
    const deleted = tabA.createInputHistoryIdentity('runtime-a', '/repo', 'session-a');
    if (!deleted) throw new Error('identity missing');
    tabA.useInputHistoryStore.getState().appendSubmissions(deleted, [
      tabA.createInputHistorySubmission('deleted', []),
    ]);

    const tabB = await importStoreModule();
    const retained = tabB.createInputHistoryIdentity('runtime-a', '/repo', 'session-b');
    if (!retained) throw new Error('identity missing');
    tabB.useInputHistoryStore.getState().appendSubmissions(retained, [
      tabB.createInputHistorySubmission('retained', []),
    ]);

    tabA.useInputHistoryStore.getState().clearSession(deleted);

    const observer = await importStoreModule();
    observer.useInputHistoryStore.getState().applyScope('session');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), deleted)).toEqual([]);
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), retained).map((entry) => entry.text)).toEqual(['retained']);
    observer.useInputHistoryStore.getState().applyScope('global');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), deleted).map((entry) => entry.text)).toEqual([
      'deleted',
      'retained',
    ]);
  });

  test('quota fallback preserves the configured entry limit while storing fewer entries', async () => {
    installWindow(createQuotaStorage(25));
    const mod = await importStoreModule();
    const identity = mod.createInputHistoryIdentity('runtime-a', '/repo', 'session-1');
    if (!identity) throw new Error('identity missing');

    mod.useInputHistoryStore.getState().applyEntryLimit(100);
    mod.useInputHistoryStore.getState().appendSubmissions(identity, Array.from({ length: 30 }, (_, index) => (
      mod.createInputHistorySubmission(`entry-${index}`, [])
    )));

    const observer = await importStoreModule();
    expect(observer.useInputHistoryStore.getState().entryLimit).toBe(100);
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), identity)).toHaveLength(25);
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), identity)[0]?.text).toBe('entry-5');
  });
  test('retains failed appends while reconciling newer writes from another tab', async () => {
    const storage = createFakeStorage();
    installWindow(storage);
    const tab = await importStoreModule();
    const otherTab = await importStoreModule();
    const identity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'session-a' };
    const append = (text: string) => tab.useInputHistoryStore.getState().appendSubmissions(identity, [tab.createInputHistorySubmission(text, [])]);
    append('A');
    const write = storage.setItem;
    storage.setItem = () => { throw new Error('write denied'); };
    append('B');
    storage.setItem = write;
    otherTab.useInputHistoryStore.getState().appendSubmissions(identity, [otherTab.createInputHistorySubmission('other tab', [])]);
    append('C');
    const observer = await importStoreModule();
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), identity).map((entry) => entry.text).sort()).toEqual(['A', 'B', 'C', 'other tab']);
  });

  test('a failed clear cannot resurrect its bucket after writes recover', async () => {
    const storage = createFakeStorage();
    installWindow(storage);
    const tab = await importStoreModule();
    const deleted = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'deleted' };
    const retained = { ...deleted, sessionId: 'retained' };
    tab.useInputHistoryStore.getState().appendSubmissions(deleted, [tab.createInputHistorySubmission('A', [])]);
    const write = storage.setItem;
    storage.setItem = () => { throw new Error('write denied'); };
    tab.useInputHistoryStore.getState().clearSession(deleted);
    storage.setItem = write;
    tab.useInputHistoryStore.getState().appendSubmissions(retained, [tab.createInputHistorySubmission('B', [])]);
    const observer = await importStoreModule();
    observer.useInputHistoryStore.getState().applyScope('session');
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), deleted)).toEqual([]);
    expect(observer.selectInputHistoryEntries(observer.useInputHistoryStore.getState(), retained).map((entry) => entry.text)).toEqual(['B']);
  });

});
