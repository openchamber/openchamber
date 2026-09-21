import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePermissionAutoAcceptBridgeMessage } from './bridge-permission-auto-accept-runtime';

const createContext = () => {
  const values = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
  };
};

describe('VS Code permission auto-accept policy bridge', () => {
  test('persists policy and broadcasts the authoritative snapshot', async () => {
    const context = createContext();
    const broadcasts: unknown[] = [];
    const dependencies = { broadcast: async (snapshot: unknown) => { broadcasts.push(snapshot); } };
    const response = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set',
      payload: { sessionId: 'root', enabled: true },
    }, context, dependencies);

    assert.equal(response?.success, true);
    assert.deepEqual(response?.data, { sessions: { root: true }, revision: 1 });
    assert.deepEqual(broadcasts, [{ sessions: { root: true }, revision: 1 }]);

    const reloaded = await handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:get',
    }, context, dependencies);
    assert.deepEqual(reloaded?.data, { sessions: { root: true }, revision: 1 });
  });

  test('serializes concurrent writes without losing policy entries', async () => {
    const context = createContext();
    const dependencies = { broadcast: async () => undefined };
    const first = handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set',
      payload: { sessionId: 'root', enabled: true },
    }, context, dependencies);
    const second = handlePermissionAutoAcceptBridgeMessage({
      id: '2',
      type: 'api:permission-auto-accept:set',
      payload: { sessionId: 'child', enabled: false },
    }, context, dependencies);

    await Promise.all([first, second]);
    const reloaded = await handlePermissionAutoAcceptBridgeMessage({
      id: '3',
      type: 'api:permission-auto-accept:get',
    }, context, dependencies);
    assert.deepEqual(reloaded?.data, { sessions: { root: true, child: false }, revision: 2 });
  });

  test('rejects malformed policy writes', async () => {
    const broadcasts: unknown[] = [];
    const response = await handlePermissionAutoAcceptBridgeMessage({
      id: '1',
      type: 'api:permission-auto-accept:set',
      payload: { sessionId: 'root', enabled: 'yes' },
    }, createContext(), { broadcast: async (snapshot) => { broadcasts.push(snapshot); } });

    assert.equal(response?.success, false);
    assert.deepEqual(broadcasts, []);
  });
});
