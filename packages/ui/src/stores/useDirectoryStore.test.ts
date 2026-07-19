import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  deferred,
  emitRuntimeEndpointChanged,
  installRuntimeSettingsTestWindow,
  resetRuntimeSettingsTestState,
  restoreRuntimeSettingsTestWindow,
  runtimeWindow,
  setFilesystemHomeResolver,
  setRuntimeKey,
  storageValues,
  updateDesktopSettings,
} from './runtimeSettingsTestSupport';
import type { Deferred } from './runtimeSettingsTestSupport';

installRuntimeSettingsTestWindow();

const { useDirectoryStore } = await import('./useDirectoryStore');

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const resetDirectoryStore = () => {
  useDirectoryStore.setState({
    currentDirectory: '/Users/local-user/projects/app',
    directoryHistory: ['/Users/local-user/projects/app'],
    historyIndex: 0,
    homeDirectory: '/Users/local-user',
    hasPersistedDirectory: true,
    isHomeReady: true,
    isSwitchingDirectory: false,
  });
};

describe('useDirectoryStore runtime switching', () => {
  afterAll(() => {
    restoreRuntimeSettingsTestWindow();
  });

  beforeEach(async () => {
    resetRuntimeSettingsTestState();
    storageValues.set('homeDirectory', '/Users/local-user');
    storageValues.set('lastDirectory', '/Users/local-user/projects/app');
    resetDirectoryStore();
    await flushAsyncWork();
    updateDesktopSettings.mockClear();
  });

  test('keeps every unscoped directory key local while persisting remote-derived values remotely', async () => {
    setRuntimeKey('remote-runtime');
    setFilesystemHomeResolver(async () => '/home/remote-user');
    emitRuntimeEndpointChanged({ runtimeKey: 'remote-runtime', previousRuntimeKey: 'local' });
    await flushAsyncWork();

    expect(useDirectoryStore.getState().homeDirectory).toBe('/home/remote-user');
    expect(storageValues.get('homeDirectory')).toBe('/Users/local-user');
    expect(storageValues.get('lastDirectory')).toBe('/Users/local-user/projects/app');
    expect(updateDesktopSettings).toHaveBeenCalledWith({ homeDirectory: '/home/remote-user' });

    useDirectoryStore.getState().setDirectory('/home/remote-user/one');
    useDirectoryStore.getState().setDirectory('/home/remote-user/two');
    useDirectoryStore.getState().goBack();
    useDirectoryStore.getState().goForward();
    useDirectoryStore.getState().synchronizeHomeDirectory('/home/remote-user/synced');

    expect(storageValues.get('homeDirectory')).toBe('/Users/local-user');
    expect(storageValues.get('lastDirectory')).toBe('/Users/local-user/projects/app');
    expect(updateDesktopSettings).toHaveBeenCalledWith({ lastDirectory: '/home/remote-user/one' });
    expect(updateDesktopSettings).toHaveBeenCalledWith({ lastDirectory: '/home/remote-user/two' });
    expect(updateDesktopSettings).toHaveBeenCalledWith({ homeDirectory: '/home/remote-user/synced' });

    runtimeWindow.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: {
        homeDirectory: '/home/remote-user',
        lastDirectory: '/home/remote-user/projects/app',
      },
    }));

    expect(useDirectoryStore.getState().currentDirectory).toBe('/home/remote-user/projects/app');
    expect(storageValues.get('lastDirectory')).toBe('/Users/local-user/projects/app');
  });

  test('rejects a stale home resolution after an A-to-B-to-A switch', async () => {
    const requests: Deferred<string | null>[] = [];
    setFilesystemHomeResolver(() => {
      const request = deferred<string | null>();
      requests.push(request);
      return request.promise;
    });

    setRuntimeKey('runtime-a');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-a', previousRuntimeKey: 'local' });
    await Promise.resolve();
    setRuntimeKey('runtime-b');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-b', previousRuntimeKey: 'runtime-a' });
    await Promise.resolve();
    setRuntimeKey('runtime-a');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-a', previousRuntimeKey: 'runtime-b' });
    await Promise.resolve();
    updateDesktopSettings.mockClear();

    requests[0]?.resolve('/home/runtime-a-stale');
    await flushAsyncWork();

    expect(useDirectoryStore.getState().homeDirectory).toBe('/');
    expect(updateDesktopSettings).not.toHaveBeenCalledWith({ homeDirectory: '/home/runtime-a-stale' });

    requests[2]?.resolve('/home/runtime-a-current');
    await flushAsyncWork();

    expect(useDirectoryStore.getState().homeDirectory).toBe('/home/runtime-a-current');
    expect(updateDesktopSettings).toHaveBeenCalledWith({ homeDirectory: '/home/runtime-a-current' });
  });
});
