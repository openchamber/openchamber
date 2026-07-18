import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePermissionAutoAcceptBridgeMessage } from './bridge-permission-auto-accept-runtime';

const createContext = () => {
  const values = new Map<string, unknown>();
  const workspaceValues = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
    workspaceState: {
      get: (key: string) => workspaceValues.get(key),
      update: async (key: string, value: unknown) => { workspaceValues.set(key, value); },
    },
  };
};

const flushTimers = async (count = 4) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};

describe('VS Code permission auto-accept policy bridge', () => {
  test('persists policy and broadcasts the authoritative snapshot', async () => {
    const context = createContext();
    const broadcasts: unknown[] = [];
    const dependencies = { broadcast: async (snapshot: unknown) => { broadcasts.push(snapshot); } };
    const response = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set-session',
      payload: { sessionId: 'root', enabled: true },
    }, context, dependencies);

    assert.equal(response?.success, true);
    assert.deepEqual(response?.data, { default: false, sessions: { root: true } });
    assert.deepEqual(broadcasts, [{ default: false, sessions: { root: true } }]);

    const reloaded = await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:get',
    }, context, dependencies);
    assert.deepEqual(reloaded?.data, { default: false, sessions: { root: true } });
  });

  test('persists the global default and broadcasts it to all webviews', async () => {
    const context = createContext();
    const broadcasts: unknown[] = [];
    const response = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set-default',
      payload: { enabled: true },
    }, context, { broadcast: async (snapshot) => { broadcasts.push(snapshot); } });

    assert.equal(response?.success, true);
    assert.deepEqual(response?.data, { default: true, sessions: {} });
    assert.deepEqual(broadcasts, [{ default: true, sessions: {} }]);
  });

  test('rejects malformed policy writes', async () => {
    const broadcasts: unknown[] = [];
    const response = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set-session',
      payload: { sessionId: 'root', enabled: 'yes' },
    }, createContext(), { broadcast: async (snapshot) => { broadcasts.push(snapshot); } });

    assert.equal(response?.success, false);
    assert.deepEqual(broadcasts, []);
  });

  test('fails closed to a false global default when stored data is missing or malformed', async () => {
    const missing = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:get',
    }, createContext(), { broadcast: async () => undefined });
    assert.deepEqual(missing?.data, { default: false, sessions: {} });

    const malformedContext = createContext();
    await malformedContext.globalState.update('permissionAutoAccept', { default: 'yes', sessions: { root: true } });
    const malformed = await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:get',
    }, malformedContext, { broadcast: async () => undefined });
    assert.deepEqual(malformed?.data, { default: false, sessions: { root: true } });
  });

  test('keeps policies isolated across runtime identities', async () => {
    const context = createContext();

    await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set-default',
      payload: { enabled: true },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });

    await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:set-session',
      payload: { sessionId: 'root', enabled: false },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-b',
    });

    const runtimeA = await handlePermissionAutoAcceptBridgeMessage({
      id: '3',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });
    const runtimeB = await handlePermissionAutoAcceptBridgeMessage({
      id: '4',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-b',
    });

    assert.deepEqual(runtimeA?.data, { default: true, sessions: {} });
    assert.deepEqual(runtimeB?.data, { default: false, sessions: { root: false } });
  });

  test('migrates only legacy per-session overrides into the scoped workspace policy', async () => {
    const context = createContext();
    await context.globalState.update('permissionAutoAccept', { default: true, sessions: { root: true } });

    const migrated = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });

    assert.deepEqual(migrated?.data, { default: false, sessions: { root: true } });

    await context.globalState.update('permissionAutoAccept', undefined);
    const reloaded = await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });
    assert.deepEqual(reloaded?.data, { default: false, sessions: { root: true } });
  });

  test('serializes first-time GET migration with a concurrent session write', async () => {
    const values = new Map<string, unknown>();
    const workspaceValues = new Map<string, unknown>();
    let updateCount = 0;
    const context = {
      globalState: {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      workspaceState: {
        get: (key: string) => workspaceValues.get(key),
        update: async (key: string, value: unknown) => {
          updateCount += 1;
          if (updateCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          workspaceValues.set(key, value);
        },
      },
    };
    await context.globalState.update('permissionAutoAccept', { default: true, sessions: { root: true } });

    const getPromise = handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });
    await flushTimers();
    const setPromise = handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:set-session',
      payload: { sessionId: 'root', enabled: false },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });

    const [getResult, setResult] = await Promise.all([getPromise, setPromise]);
    assert.deepEqual(getResult?.data, { default: false, sessions: { root: true } });
    assert.deepEqual(setResult?.data, { default: false, sessions: { root: false } });
    assert.deepEqual(workspaceValues.get('permissionAutoAccept:runtime-a'), { default: false, sessions: { root: false } });
  });

  test('serializes first-time GET migration with a concurrent default write', async () => {
    const values = new Map<string, unknown>();
    const workspaceValues = new Map<string, unknown>();
    let updateCount = 0;
    const context = {
      globalState: {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      workspaceState: {
        get: (key: string) => workspaceValues.get(key),
        update: async (key: string, value: unknown) => {
          updateCount += 1;
          if (updateCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          workspaceValues.set(key, value);
        },
      },
    };
    await context.globalState.update('permissionAutoAccept', { default: true, sessions: { root: true } });

    const getPromise = handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:get',
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });
    await flushTimers();
    const setPromise = handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:set-default',
      payload: { enabled: true },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });

    const [getResult, setResult] = await Promise.all([getPromise, setPromise]);
    assert.deepEqual(getResult?.data, { default: false, sessions: { root: true } });
    assert.deepEqual(setResult?.data, { default: true, sessions: { root: true } });
    assert.deepEqual(workspaceValues.get('permissionAutoAccept:runtime-a'), { default: true, sessions: { root: true } });
  });

  test('recovers the queue after an initial migration write error', async () => {
    const values = new Map<string, unknown>();
    const workspaceValues = new Map<string, unknown>();
    let shouldFailMigration = true;
    const context = {
      globalState: {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      workspaceState: {
        get: (key: string) => workspaceValues.get(key),
        update: async (key: string, value: unknown) => {
          if (shouldFailMigration) {
            shouldFailMigration = false;
            throw new Error('write failed');
          }
          workspaceValues.set(key, value);
        },
      },
    };
    await context.globalState.update('permissionAutoAccept', { default: false, sessions: { root: true } });

    await assert.rejects(
      handlePermissionAutoAcceptBridgeMessage({
        id: '1',
        type: 'api:permission-auto-accept:get',
      }, context, {
        broadcast: async () => undefined,
        getStorageIdentity: () => 'runtime-a',
      }),
      /write failed/,
    );

    const next = await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:set-default',
      payload: { enabled: true },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => 'runtime-a',
    });

    assert.deepEqual(next?.data, { default: true, sessions: { root: true } });
    assert.deepEqual(workspaceValues.get('permissionAutoAccept:runtime-a'), { default: true, sessions: { root: true } });
  });

  test('captures the storage identity once per operation so it cannot change mid-write', async () => {
    const values = new Map<string, unknown>();
    const workspaceValues = new Map<string, unknown>();
    let identity = 'runtime-a';
    let releaseUpdate: (() => void) | null = null;
    const context = {
      globalState: {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      workspaceState: {
        get: (key: string) => workspaceValues.get(key),
        update: async (key: string, value: unknown) => {
          await new Promise<void>((resolve) => {
            releaseUpdate = resolve;
          });
          workspaceValues.set(key, value);
        },
      },
    };

    const pending = handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set-default',
      payload: { enabled: true },
    }, context, {
      broadcast: async () => undefined,
      getStorageIdentity: () => identity,
    });
    await flushTimers();
    identity = 'runtime-b';
    (releaseUpdate as (() => void) | null)?.();

    const result = await pending;
    assert.deepEqual(result?.data, { default: true, sessions: {} });
    assert.deepEqual(workspaceValues.get('permissionAutoAccept:runtime-a'), { default: true, sessions: {} });
    assert.equal(workspaceValues.has('permissionAutoAccept:runtime-b'), false);
  });

  test('serializes concurrent writes so default and session policies both persist regardless of completion order', async () => {
    const runCase = async (order: 'default-first' | 'session-first') => {
      const updates: Array<{ key: string; value: unknown }> = [];
      let updateCount = 0;
      const values = new Map<string, unknown>();
      const context = {
        globalState: {
          get: () => undefined,
          update: async () => undefined,
        },
        workspaceState: {
          get: (key: string) => values.get(key),
          update: async (key: string, value: unknown) => {
            updateCount += 1;
            if (updateCount === 1) {
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            updates.push({ key, value });
            values.set(key, value);
          },
        },
      };

      const setDefault = () => handlePermissionAutoAcceptBridgeMessage({
        id: '1',
        type: 'api:permission-auto-accept:set-default',
        payload: { enabled: true },
      }, context, {
        broadcast: async () => undefined,
        getStorageIdentity: () => 'runtime-a',
      });
      const setSession = () => handlePermissionAutoAcceptBridgeMessage({
        id: '2',
        type: 'api:permission-auto-accept:set-session',
        payload: { sessionId: 'root', enabled: false },
      }, context, {
        broadcast: async () => undefined,
        getStorageIdentity: () => 'runtime-a',
      });

      const first = order === 'default-first' ? setDefault() : setSession();
      const second = order === 'default-first' ? setSession() : setDefault();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.deepEqual(values.get('permissionAutoAccept:runtime-a'), { default: true, sessions: { root: false } });
      assert.equal(updates.length, 2);
      assert.deepEqual(updates.at(-1)?.value, { default: true, sessions: { root: false } });

      if (order === 'default-first') {
        assert.deepEqual(firstResult?.data, { default: true, sessions: {} });
        assert.deepEqual(secondResult?.data, { default: true, sessions: { root: false } });
      } else {
        assert.deepEqual(firstResult?.data, { default: false, sessions: { root: false } });
        assert.deepEqual(secondResult?.data, { default: true, sessions: { root: false } });
      }
    };

    await runCase('default-first');
    await runCase('session-first');
  });
});
