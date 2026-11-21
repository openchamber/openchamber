import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

type StoredUIState = Partial<ReturnType<typeof useUIStore.getState>> & { wideChatLayoutEnabled?: boolean };

const hydrate = async (version: number, stored: StoredUIState) => {
  const { chatWidth: _initialWidth, ...initial } = useUIStore.getInitialState();
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...initial, ...stored } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  return useUIStore.getState();
};

describe('chat width migration', () => {
  test('defaults to the reading column', () => {
    expect(useUIStore.getInitialState().chatWidth).toBe('default');
  });

  test('the old Wide chat layout becomes Full', async () => {
    const state = await hydrate(29, { wideChatLayoutEnabled: true });
    expect(state.chatWidth).toBe('full');
    expect('wideChatLayoutEnabled' in state).toBe(false);
  });

  test('the old layout switched off becomes Default', async () => {
    expect((await hydrate(29, { wideChatLayoutEnabled: false })).chatWidth).toBe('default');
  });

  test('runs once: a width picked after the migration stays', async () => {
    expect((await hydrate(30, { chatWidth: 'wider' })).chatWidth).toBe('wider');
  });
});
