import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrateFrom = async (version: number, tableCellWrap: boolean): Promise<void> => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), tableCellWrap } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

describe('table cell wrap default', () => {
  test('wraps table cells by default', () => {
    expect(useUIStore.getInitialState().tableCellWrap).toBe(true);
  });

  test('turns wrapping on for a v22 store that held the old default', async () => {
    await hydrateFrom(22, false);
    expect(useUIStore.getState().tableCellWrap).toBe(true);
  });

  test('keeps a choice stored after the default changed', async () => {
    await hydrateFrom(23, false);
    expect(useUIStore.getState().tableCellWrap).toBe(false);
  });
});
