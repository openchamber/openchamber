import { afterEach, describe, expect, test } from 'bun:test';
import { createJSONStorage, type StorageValue } from 'zustand/middleware';
import { useUIStore } from './useUIStore';

type UIStoreState = ReturnType<typeof useUIStore.getState>;
const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrateFrom = async (version: number, state: Partial<UIStoreState>): Promise<void> => {
  useUIStore.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => JSON.stringify({ version, state }),
    setItem: () => undefined,
    removeItem: () => undefined,
  })) });
  await useUIStore.persist.rehydrate();
};

describe('command palette archived sessions preference', () => {
  test('is off by default on a fresh store', () => {
    expect(useUIStore.getInitialState().commandPaletteShowArchivedSessions).toBe(false);
  });

  test('stays off when hydrating an older persisted state without the key', async () => {
    useUIStore.setState({ commandPaletteShowArchivedSessions: false });
    await hydrateFrom(26, { sessionTabsEnabled: true });
    expect(useUIStore.getState().commandPaletteShowArchivedSessions).toBe(false);
  });

  test('stays off when hydrating the current version without the key', async () => {
    useUIStore.setState({ commandPaletteShowArchivedSessions: false });
    await hydrateFrom(originalOptions.version ?? 27, { sessionTabsEnabled: true });
    expect(useUIStore.getState().commandPaletteShowArchivedSessions).toBe(false);
  });

  test('an explicit choice survives a persist round trip', async () => {
    let saved: StorageValue<UIStoreState> = { state: useUIStore.getInitialState(), version: originalOptions.version };
    useUIStore.persist.setOptions({ storage: {
      getItem: () => saved,
      setItem: (_name, value) => { saved = JSON.parse(JSON.stringify(value)); },
      removeItem: () => undefined,
    } });
    useUIStore.setState({ commandPaletteShowArchivedSessions: false });
    useUIStore.getState().setCommandPaletteShowArchivedSessions(true);
    expect('commandPaletteShowArchivedSessions' in saved.state).toBe(true);
    expect(saved.state.commandPaletteShowArchivedSessions).toBe(true);

    useUIStore.persist.setOptions({ storage: { getItem: () => saved, setItem: () => undefined, removeItem: () => undefined } });
    useUIStore.setState({ commandPaletteShowArchivedSessions: false });
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().commandPaletteShowArchivedSessions).toBe(true);
  });
});
