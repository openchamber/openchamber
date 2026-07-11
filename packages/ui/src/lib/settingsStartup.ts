type SettingsStartupDependencies = {
  runtimeKey: string;
  initializeAppearance: () => Promise<void>;
  syncSettings: () => Promise<void>;
  applyDirectory: () => Promise<void>;
  onError: (stage: 'appearance' | 'secondary', error: unknown) => void;
};

const hydrationByRuntime = new Map<string, Promise<boolean>>();

export const ensureSettingsHydrated = ({
  runtimeKey,
  initializeAppearance,
  syncSettings,
  applyDirectory,
  onError,
}: SettingsStartupDependencies): Promise<boolean> => {
  const existing = hydrationByRuntime.get(runtimeKey);
  if (existing) return existing;

  const hydration = (async () => {
    try {
      await initializeAppearance();
    } catch (error) {
      onError('appearance', error);
      return false;
    }

    try {
      await Promise.all([syncSettings(), applyDirectory()]);
    } catch (error) {
      onError('secondary', error);
    }
    return true;
  })();
  hydrationByRuntime.set(runtimeKey, hydration);
  return hydration;
};

export const runSettingsStartup = async ({
  runtimeKey,
  initializeAppearance,
  syncSettings,
  applyDirectory,
  startWatchers,
  onError,
}: SettingsStartupDependencies & { startWatchers: () => void }): Promise<void> => {
  const appearanceReady = await ensureSettingsHydrated({
    runtimeKey,
    initializeAppearance,
    syncSettings,
    applyDirectory,
    onError,
  });
  if (!appearanceReady) return;

  // Autosave observes Zustand changes. Starting it before hydration finishes
  // writes transient/default values back to the server during cold startup.
  startWatchers();
};
