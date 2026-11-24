import { createThemeFolderWatch } from '../appearance/theme-watch.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { SettingsFileChange } from '../settings/settings-file-state.js';

type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
type ThemeWatchOptions = Parameters<typeof createThemeFolderWatch>[0];
type FolderWatchDependencies = Pick<ThemeWatchOptions, 'fsPromises' | 'path'> & {
  settingsRuntime: Pick<SettingsRuntime, 'watchSettingsFiles' | 'reconcileExternalSettings' | 'subscribeTakenInSettings'>;
  customThemesDir?: string | null;
};

export const createFeatureFolderWatches = () => {
  let themeWatch: ReturnType<typeof createThemeFolderWatch> | null = null;
  let settingsWatch: ReturnType<SettingsRuntime['watchSettingsFiles']> | null = null;
  let unsubscribeTakenIn: (() => void) | null = null;
  const stop = () => {
    unsubscribeTakenIn?.();
    unsubscribeTakenIn = null;
    themeWatch?.stop();
    themeWatch = null;
    settingsWatch?.stop();
    settingsWatch = null;
  };
  const start = async (
    dependencies: FolderWatchDependencies,
    announceChange: (type: string, properties?: SettingsFileChange) => void,
  ) => {
    stop();
    const { fsPromises, path, customThemesDir } = dependencies;
    themeWatch = customThemesDir ? createThemeFolderWatch({
      fsPromises, path, themesDir: customThemesDir,
      onChange: () => announceChange('openchamber:themes-changed'),
    }) : null;
    unsubscribeTakenIn = dependencies.settingsRuntime.subscribeTakenInSettings((changes) => {
      for (const change of changes) announceChange('openchamber:settings-changed', change);
    });
    const next = dependencies.settingsRuntime.watchSettingsFiles({
      onChange: async (properties) => {
        const changes = await dependencies.settingsRuntime.reconcileExternalSettings(properties);
        if (settingsWatch !== next) return;
        for (const change of changes) announceChange('openchamber:settings-changed', change);
      },
    });
    settingsWatch = next;
    await next.ready;
  };
  return { start, stop };
};
