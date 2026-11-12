import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_CHAT_WIDTH, type ChatWidthLevel } from '@/lib/chatWidth';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

type StoredUiState = Partial<ReturnType<typeof useUIStore.getInitialState>> & {
  wideChatLayoutEnabled?: boolean;
};

const hydrateFrom = async (version: number, state: StoredUiState): Promise<void> => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), ...state } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

describe('chat width', () => {
  test('starts at the compact column', () => {
    expect(DEFAULT_CHAT_WIDTH).toBe('compact');
    expect(useUIStore.getInitialState().chatWidth).toBe('compact');
  });

  test('the setter stores the chosen level', () => {
    useUIStore.getState().setChatWidth('full');
    expect(useUIStore.getState().chatWidth).toBe('full');
  });

  test('reads a stored wide-layout switch as full', async () => {
    await hydrateFrom(28, { wideChatLayoutEnabled: true });
    expect(useUIStore.getState().chatWidth).toBe('full');
    expect('wideChatLayoutEnabled' in useUIStore.getState()).toBe(false);
  });

  test('reads a stored off switch as the compact default', async () => {
    await hydrateFrom(28, { wideChatLayoutEnabled: false });
    expect(useUIStore.getState().chatWidth).toBe('compact');
  });

  test('keeps a level stored after the migration', async () => {
    await hydrateFrom(29, { chatWidth: 'standard' });
    expect(useUIStore.getState().chatWidth).toBe('standard');
  });

  test('keeps the wide level stored after the migration', async () => {
    await hydrateFrom(29, { chatWidth: 'wide' });
    expect(useUIStore.getState().chatWidth).toBe('wide');
  });
  test('a level from a newer build falls back to compact on hydration', async () => {
    // A downgrade: the store was written by a newer build (a higher version)
    // that knew a level this build does not. A version mismatch runs the
    // migration, which clamps the level.
    // SAFETY: 'huge' stands for any level a newer build may have written; the
    // hydration clamp is what this test exercises, not the type.
    await hydrateFrom(30, { chatWidth: 'huge' as ChatWidthLevel });
    expect(useUIStore.getState().chatWidth).toBe('compact');
  });

  test('the setter clamps an unknown level to compact', () => {
    // SAFETY: same as above, the setter is expected to reject the value.
    useUIStore.getState().setChatWidth('huge' as ChatWidthLevel);
    expect(useUIStore.getState().chatWidth).toBe('compact');
  });
});
