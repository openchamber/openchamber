import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  installRuntimeSettingsTestWindow,
  resetRuntimeSettingsTestState,
  restoreRuntimeSettingsTestWindow,
  runtimeWindow,
  setRuntimeKey,
  updateDesktopSettings,
} from '../stores/runtimeSettingsTestSupport';

installRuntimeSettingsTestWindow();

const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { applyPersistedDirectoryPreferences } = await import('./directoryPersistence');

describe('applyPersistedDirectoryPreferences', () => {
  beforeEach(() => {
    resetRuntimeSettingsTestState();
    setRuntimeKey('remote-runtime');
    updateDesktopSettings.mockClear();
    useDirectoryStore.setState({
      currentDirectory: '/',
      directoryHistory: ['/'],
      historyIndex: 0,
      homeDirectory: '/',
      hasPersistedDirectory: false,
      isHomeReady: false,
      isSwitchingDirectory: false,
    });
    Object.assign(runtimeWindow, {
      localStorage: {
        getItem: (key: string) => key === 'lastDirectory' ? '/Users/local-user/projects/app' : null,
      },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(runtimeWindow, 'localStorage');
    restoreRuntimeSettingsTestWindow();
  });

  test('does not apply a browser-local last directory to a remote runtime', async () => {
    await applyPersistedDirectoryPreferences();

    expect(useDirectoryStore.getState().currentDirectory).toBe('/');
    expect(updateDesktopSettings).not.toHaveBeenCalled();
  });

  test('continues to restore the browser-local last directory for the local runtime', async () => {
    setRuntimeKey('local');

    await applyPersistedDirectoryPreferences();

    expect(useDirectoryStore.getState().currentDirectory).toBe('/Users/local-user/projects/app');
    expect(updateDesktopSettings).toHaveBeenCalledWith({ lastDirectory: '/Users/local-user/projects/app' });
  });
});
