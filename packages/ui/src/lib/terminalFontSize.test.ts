import { describe, expect, test } from 'bun:test';
import { normalizeTerminalFontSize } from './terminalFontSize';
import { useUIStore } from '@/stores/useUIStore';

describe('terminal font size preference', () => {
  test('normalizes to the renderer range and default', () => {
    for (const [input, expected] of [[2, 9], [52, 32], [14.4, 14], [NaN, 14], [Infinity, 14]]) {
      expect(normalizeTerminalFontSize(input)).toBe(expected);
      useUIStore.getState().setTerminalFontSize(input);
      expect(useUIStore.getState().terminalFontSize).toBe(expected);
    }
    expect(normalizeTerminalFontSize()).toBe(14);
  });

  test('converts older local preferences and persists the supported value', async () => {
    const options = useUIStore.persist.getOptions();
    for (const [input, expected] of [[52, 32], [6, 9], [18, 18], ['invalid', 14]]) {
      const migrated = await options.migrate?.({ terminalFontSize: input }, 24);
      expect(migrated).toMatchObject({ terminalFontSize: expected });
    }
    useUIStore.getState().setTerminalFontSize(23);
    expect(options.partialize?.(useUIStore.getState())).toMatchObject({ terminalFontSize: 23 });
    useUIStore.getState().setTerminalFontSize(14);
  });

  test('hydrates an older value and round-trips later size changes', async () => {
    const options = useUIStore.persist.getOptions();
    const originalState = useUIStore.getState();
    let saved: Parameters<NonNullable<typeof options.storage>['setItem']>[1] = {
      version: 24, state: { ...originalState, terminalFontSize: 52 },
    };
    try {
      useUIStore.persist.setOptions({ storage: {
        getItem: () => saved,
        setItem: (_name, value) => { saved = value; },
        removeItem: () => undefined,
      } });
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().terminalFontSize).toBe(32);
      useUIStore.getState().setTerminalFontSize(21);
      const persisted = saved;
      useUIStore.setState({ terminalFontSize: 14 });
      saved = persisted;
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().terminalFontSize).toBe(21);
    } finally {
      useUIStore.persist.setOptions(options);
      useUIStore.setState(originalState, true);
    }
  });
});
