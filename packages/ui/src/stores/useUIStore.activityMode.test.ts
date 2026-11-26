import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const rehydrate = async (version: number, activityRenderMode: string) => {
  const { keepEarlierReplies: _unset, ...initial } = useUIStore.getInitialState();
  useUIStore.setState({ keepEarlierReplies: false });
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: JSON.parse(JSON.stringify({ ...initial, activityRenderMode })) }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  const { activityRenderMode: mode, keepEarlierReplies } = useUIStore.getState();
  return { mode, keepEarlierReplies };
};

describe('activity mode', () => {
  test('is Grouped with earlier replies folded for a new user', () => {
    const { activityRenderMode, keepEarlierReplies } = useUIStore.getInitialState();
    expect({ activityRenderMode, keepEarlierReplies }).toEqual({ activityRenderMode: 'grouped', keepEarlierReplies: false });
  });

  test('turns Show notes into Grouped with earlier replies kept open', async () => {
    expect(await rehydrate(30, 'text')).toEqual({ mode: 'grouped', keepEarlierReplies: true });
  });

  test('moves the old Expanded default to Grouped and leaves Collapsed', async () => {
    expect(await rehydrate(30, 'summary')).toEqual({ mode: 'grouped', keepEarlierReplies: false });
    expect(await rehydrate(30, 'collapsed')).toEqual({ mode: 'collapsed', keepEarlierReplies: false });
  });

  test('keeps Expanded chosen after the upgrade', async () => {
    expect(await rehydrate(31, 'summary')).toEqual({ mode: 'summary', keepEarlierReplies: false });
  });
});
