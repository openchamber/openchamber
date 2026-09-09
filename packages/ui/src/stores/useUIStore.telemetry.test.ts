import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

describe('telemetry settings migration', () => {
  test('shows telemetry by default', () => {
    expect(useUIStore.getInitialState().workStatusHiddenSections).toEqual([]);
  });

  for (const version of [18, 19, 20]) {
    test(`migrates real v${version} hydration without losing existing hidden sections`, async () => {
      useUIStore.persist.setOptions({ storage: {
        getItem: () => ({ version, state: { ...useUIStore.getInitialState(), workStatusHiddenSections: ['mcp', 'telemetry'] } }),
        setItem: () => undefined,
        removeItem: () => undefined,
      } });
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
      expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(false);
      expect(useUIStore.persist.getOptions().version).toBe(22);
    });
  }

  test('preserves an explicitly hidden section from v20', async () => {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({ version: 20, state: { ...useUIStore.getInitialState(), workStatusHiddenSections: ['mcp', 'telemetry'], workStatusHiddenSectionsExplicit: true } }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp', 'telemetry']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
  });

  test('explicit hiding round-trips through the actual persisted projection and hydration', async () => {
    let saved: Parameters<NonNullable<typeof originalOptions.storage>['setItem']>[1] = { state: useUIStore.getInitialState(), version: originalOptions.version };
    useUIStore.persist.setOptions({ storage: {
      getItem: () => saved,
      setItem: (_name, value) => { saved = value; },
      removeItem: () => undefined,
    } });
    useUIStore.setState({ workStatusHiddenSections: ['mcp'], workStatusHiddenSectionsExplicit: false });
    useUIStore.getState().setWorkStatusSectionVisible('telemetry', false);
    useUIStore.persist.setOptions({ storage: { getItem: () => saved, setItem: () => undefined, removeItem: () => undefined } });
    useUIStore.setState({ workStatusHiddenSections: [], workStatusHiddenSectionsExplicit: false });
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp', 'telemetry']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
  });

  test('can show telemetry again after hiding it', () => {
    useUIStore.setState({ workStatusHiddenSections: ['mcp', 'telemetry'], workStatusHiddenSectionsExplicit: true });
    useUIStore.getState().setWorkStatusSectionVisible('telemetry', true);
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
  });
});
