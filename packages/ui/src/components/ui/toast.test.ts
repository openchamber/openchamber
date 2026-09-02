import { beforeEach, describe, expect, test } from 'bun:test';
import { emptyNotificationIndex, useNotificationStore } from '@/sync/notification-store';
import { closeRecordedToast, toast } from './toast';

const resetStore = () => {
  useNotificationStore.setState({
    list: [],
    listsByRuntime: {},
    index: emptyNotificationIndex(),
  });
};

describe('toast write path', () => {
  beforeEach(() => {
    resetStore();
  });

  test('records success and error toasts as unread rows', () => {
    toast.success('Copied');
    toast.error('Failed', { description: 'network' });
    const titles = useNotificationStore.getState().list.map((item) => item.title);
    expect(titles).toContain('Copied');
    expect(titles).toContain('Failed');
    const success = useNotificationStore.getState().list.find((item) => item.title === 'Copied');
    const error = useNotificationStore.getState().list.find((item) => item.title === 'Failed');
    expect(success?.severity).toBe('success');
    expect(success?.read).toBe(false);
    expect(error?.severity).toBe('error');
    expect(error?.body).toBe('network');
    expect(error?.read).toBe(false);
  });

  test('persist false skips history', () => {
    toast.success('Transient', { persist: false });
    expect(useNotificationStore.getState().list).toEqual([]);
  });

  test('timeout leaves unread while dismiss keeps the row as read', () => {
    toast.info('Still here');
    const id = useNotificationStore.getState().list[0]?.id;
    expect(id).toBeTruthy();
    closeRecordedToast(id ?? null, true);
    expect(useNotificationStore.getState().list[0]?.read).toBe(false);
    closeRecordedToast(id ?? null, false);
    expect(useNotificationStore.getState().list[0]?.read).toBe(true);
    expect(useNotificationStore.getState().list).toHaveLength(1);
  });
});
