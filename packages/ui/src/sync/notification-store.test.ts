import { beforeEach, describe, expect, test } from 'bun:test';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  appendNotification,
  emptyNotificationIndex,
  latestSessionErrorFromList,
  useNotificationStore,
} from './notification-store';

const resetStore = () => {
  useNotificationStore.setState({
    list: [],
    listsByRuntime: {},
    index: emptyNotificationIndex(),
  });
};

describe('notification store', () => {
  beforeEach(() => {
    resetStore();
  });

  test('append then session unseen index ignores toast rows', () => {
    appendNotification({
      type: 'turn-complete',
      session: 's1',
      directory: '/proj',
      viewed: false,
      time: Date.now(),
    });
    appendNotification({
      title: 'Copied',
      severity: 'success',
      source: 'toast',
      session: 's1',
    });
    const state = useNotificationStore.getState();
    expect(state.list.length).toBe(2);
    expect(state.index.session.unseenCount.s1).toBe(1);
    expect(state.sessionUnseenCount('s1')).toBe(1);
  });

  test('timeout-style unread survives while markRead keeps the row', () => {
    const recorded = appendNotification({
      id: 'toast-1',
      title: 'Failed',
      severity: 'error',
      source: 'toast',
    });
    expect(recorded?.read).toBe(false);
    useNotificationStore.getState().markRead('toast-1');
    const row = useNotificationStore.getState().list.find((item) => item.id === 'toast-1');
    expect(row?.read).toBe(true);
    expect(useNotificationStore.getState().list).toHaveLength(1);
  });

  test('isolates history across runtime keys', () => {
    appendNotification({ title: 'Local', severity: 'error', source: 'toast', runtimeKey: 'local' });
    appendNotification({ title: 'Remote', severity: 'error', source: 'toast', runtimeKey: 'remote' });
    useNotificationStore.getState().activateRuntime('remote');
    expect(useNotificationStore.getState().list).toHaveLength(1);
    expect(useNotificationStore.getState().list[0]?.title).toBe('Remote');
    useNotificationStore.getState().activateRuntime('local');
    expect(useNotificationStore.getState().list.some((item) => item.title === 'Local')).toBe(true);
  });

  test('malformed persist merge drops bad rows and keeps valid ones', () => {
    const runtimeKey = getRuntimeKey();
    const merged = useNotificationStore.persist.getOptions().merge?.(
      {
        listsByRuntime: {
          [runtimeKey]: [{ nope: true }, { id: 'ok', source: 'toast', severity: 'info', title: 'Hi', time: Date.now() }],
        },
      },
      useNotificationStore.getState(),
    );
    expect(merged?.list).toHaveLength(1);
    expect(merged?.list[0]?.title).toBe('Hi');
  });

  test('missing persist payload does not invent records', () => {
    const merged = useNotificationStore.persist.getOptions().merge?.(
      undefined,
      useNotificationStore.getState(),
    );
    expect(merged?.list).toEqual([]);
    expect(merged?.listsByRuntime).toEqual({});
  });

  test('subtask rows do not feed session attention', () => {
    appendNotification({
      type: 'turn-complete',
      session: 'child',
      directory: '/proj',
      subtask: true,
      viewed: false,
      time: Date.now(),
    });
    const state = useNotificationStore.getState();
    expect(state.list).toHaveLength(1);
    expect(state.list[0]?.source).toBe('subtask');
    expect(state.sessionUnseenCount('child')).toBe(0);
  });

  test('remove deletes one row and clear deletes the rest', () => {
    const first = appendNotification({ title: 'One', severity: 'error', source: 'toast' });
    const second = appendNotification({ title: 'Two', severity: 'error', source: 'toast' });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    if (!first || !second) return;
    useNotificationStore.getState().remove(first.id);
    expect(useNotificationStore.getState().list.map((item) => item.id)).toEqual([second.id]);
    useNotificationStore.getState().clear([second.id]);
    expect(useNotificationStore.getState().list).toEqual([]);
  });

  test('clearAll empties the current runtime bucket including hidden kinds', () => {
    appendNotification({ title: 'Error', severity: 'error', source: 'toast' });
    appendNotification({ title: 'Copied', severity: 'success', source: 'toast' });
    appendNotification({ title: 'Remote', severity: 'error', source: 'toast', runtimeKey: 'other' });
    expect(useNotificationStore.getState().list).toHaveLength(2);
    useNotificationStore.getState().clearAll();
    expect(useNotificationStore.getState().list).toEqual([]);
    expect(useNotificationStore.getState().listsByRuntime.other).toHaveLength(1);
  });

  test('appending the same caller id after the window keeps unique record ids', () => {
    const now = Date.now();
    const first = appendNotification({
      id: 'small-model-unavailable',
      title: 'Small Model unavailable',
      severity: 'error',
      source: 'toast',
      time: now - 60_001,
    });
    const second = appendNotification({
      id: 'small-model-unavailable',
      title: 'Small Model unavailable',
      severity: 'error',
      source: 'toast',
      time: now,
    });
    expect(first?.id).toBe('small-model-unavailable');
    expect(second?.id).toBeTruthy();
    expect(second?.id).not.toBe(first?.id);
    const ids = useNotificationStore.getState().list.map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('latest session error keeps the OpenCode name and message', () => {
    const now = Date.now();
    appendNotification({
      type: 'error',
      session: 's1',
      directory: '/proj',
      time: now - 1,
      error: { name: 'ProviderAuthError', message: 'Invalid API key' },
    });
    appendNotification({
      type: 'turn-complete',
      session: 's1',
      directory: '/proj',
      time: now,
    });
    const latest = latestSessionErrorFromList(useNotificationStore.getState().list, 's1');
    expect(latest?.type).toBe('error');
    expect(latest?.error).toEqual({ name: 'ProviderAuthError', message: 'Invalid API key' });
  });

  test('empty runtime list is empty success', () => {
    const runtimeKey = getRuntimeKey();
    const merged = useNotificationStore.persist.getOptions().merge?.(
      { listsByRuntime: { [runtimeKey]: [] } },
      useNotificationStore.getState(),
    );
    expect(merged?.list).toEqual([]);
    expect(merged?.listsByRuntime[runtimeKey]).toEqual([]);
  });
});
