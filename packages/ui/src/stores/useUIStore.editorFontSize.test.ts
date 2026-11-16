import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_EDITOR_FONT_SIZE, useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrate = async (version: number, editorFontSize: number) => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), editorFontSize } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  return useUIStore.getState().editorFontSize;
};

describe('editor font size default', () => {
  test('is 12px', () => {
    expect(DEFAULT_EDITOR_FONT_SIZE).toBe(12);
    expect(useUIStore.getInitialState().editorFontSize).toBe(12);
  });

  test('moves the old 13px default to 12px', async () => {
    expect(await hydrate(27, 13)).toBe(12);
  });

  test('keeps a size the user set', async () => {
    expect(await hydrate(27, 15)).toBe(15);
  });

  test('runs once: a 13px chosen after the migration stays', async () => {
    expect(await hydrate(28, 13)).toBe(13);
  });
});
