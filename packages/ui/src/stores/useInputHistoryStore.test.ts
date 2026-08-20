import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_INPUT_HISTORY_SCOPE,
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
    expect(DEFAULT_INPUT_HISTORY_SCOPE).toBe('global');
    expect(mod.useInputHistoryStore.getState().scope).toBe('global');
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

  test('validates runtime, directory, and session identity inputs', async () => {
    installWindow(createFakeStorage());
    const mod = await importStoreModule();

    expect(isInputHistoryScope('global')).toBe(true);
    expect(isInputHistoryScope('session')).toBe(true);
    expect(isInputHistoryScope('other')).toBe(false);
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
});
