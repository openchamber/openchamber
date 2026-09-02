import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';
import {
  mergeDedupedNotification,
  normalizeNotificationAppend,
  parseNotificationPersistState,
  pruneNotifications,
  type NotificationAppendInput,
  type NotificationListsByRuntime,
  type NotificationRecord,
} from './notification-record';

export type { NotificationAction, NotificationRecord, NotificationSeverity, NotificationSource } from './notification-record';

export type ErrorNotification = {
  directory?: string;
  session?: string;
  time: number;
  viewed: boolean;
  type: 'error';
  error?: { name: string | null; message: string | null };
};

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>;
    unseenHasError: Record<string, boolean>;
  };
  project: {
    unseenCount: Record<string, number>;
    unseenHasError: Record<string, boolean>;
  };
};

export const emptyNotificationIndex = (): NotificationIndex => ({
  session: { unseenCount: {}, unseenHasError: {} },
  project: { unseenCount: {}, unseenHasError: {} },
});

const isSessionAttention = (notification: NotificationRecord): boolean => notification.source === 'session';

const buildNotificationIndex = (list: NotificationRecord[]): NotificationIndex => {
  const index = emptyNotificationIndex();

  for (const notification of list) {
    if (notification.read || !isSessionAttention(notification)) continue;

    if (notification.session) {
      index.session.unseenCount[notification.session] = (index.session.unseenCount[notification.session] ?? 0) + 1;
      if (notification.severity === 'error') index.session.unseenHasError[notification.session] = true;
    }
    if (notification.directory) {
      index.project.unseenCount[notification.directory] = (index.project.unseenCount[notification.directory] ?? 0) + 1;
      if (notification.severity === 'error') index.project.unseenHasError[notification.directory] = true;
    }
  }

  return index;
};

type NotificationPersistState = {
  listsByRuntime: NotificationListsByRuntime;
};

interface NotificationStore {
  list: NotificationRecord[];
  listsByRuntime: NotificationListsByRuntime;
  index: NotificationIndex;

  append: (notification: NotificationAppendInput) => NotificationRecord | null;
  markRead: (id: string) => void;
  markAllRead: (ids: readonly string[]) => void;
  remove: (id: string) => void;
  clear: (ids: readonly string[]) => void;
  clearAll: () => void;
  markSessionViewed: (sessionId: string) => void;
  markProjectViewed: (directory: string) => void;
  activateRuntime: (runtimeKey: string) => void;

  sessionUnseenCount: (sessionId: string) => number;
  sessionHasError: (sessionId: string) => boolean;
  projectUnseenCount: (directory: string) => number;
  projectHasError: (directory: string) => boolean;
}

const commitRuntimeList = (
  listsByRuntime: NotificationListsByRuntime,
  runtimeKey: string,
  nextList: NotificationRecord[],
): Pick<NotificationStore, 'list' | 'listsByRuntime' | 'index'> => {
  const pruned = pruneNotifications(nextList);
  const nextLists = { ...listsByRuntime, [runtimeKey]: pruned };
  const currentRuntimeKey = getRuntimeKey();
  const visible = nextLists[currentRuntimeKey] ?? [];
  return {
    listsByRuntime: nextLists,
    list: visible,
    index: buildNotificationIndex(visible),
  };
};

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set, get) => ({
      list: [],
      listsByRuntime: {},
      index: emptyNotificationIndex(),

      append: (input) => {
        const runtimeKey = getRuntimeKey();
        const notification = normalizeNotificationAppend(input, runtimeKey);
        if (!notification.title && !notification.body) return null;

        const bucket = get().listsByRuntime[notification.runtimeKey] ?? (
          notification.runtimeKey === runtimeKey ? get().list : []
        );
        const merged = mergeDedupedNotification(bucket, notification);
        set(commitRuntimeList(get().listsByRuntime, notification.runtimeKey, merged));
        const stored = get().listsByRuntime[notification.runtimeKey] ?? [];
        const newestSameKey = stored
          .filter((item) => item.dedupeKey === notification.dedupeKey)
          .reduce<NotificationRecord | null>((latest, item) => (
            latest == null || item.time >= latest.time ? item : latest
          ), null);
        return newestSameKey
          ?? stored.find((item) => item.id === notification.id)
          ?? notification;
      },

      markRead: (id) => {
        const current = get();
        let runtimeKey: string | null = null;
        let bucket: NotificationRecord[] | null = null;
        for (const [key, list] of Object.entries(current.listsByRuntime)) {
          if (list.some((item) => item.id === id)) {
            runtimeKey = key;
            bucket = list;
            break;
          }
        }
        if (!runtimeKey || !bucket) {
          if (!current.list.some((item) => item.id === id)) return;
          runtimeKey = getRuntimeKey();
          bucket = current.list;
        }
        const next = bucket.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item));
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, next));
      },

      markAllRead: (ids) => {
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        const runtimeKey = getRuntimeKey();
        const current = get();
        const bucket = current.listsByRuntime[runtimeKey] ?? current.list;
        let changed = false;
        const next = bucket.map((item) => {
          if (!idSet.has(item.id) || item.read) return item;
          changed = true;
          return { ...item, read: true };
        });
        if (!changed) return;
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, next));
      },

      remove: (id) => {
        const current = get();
        let runtimeKey: string | null = null;
        let bucket: NotificationRecord[] | null = null;
        for (const [key, list] of Object.entries(current.listsByRuntime)) {
          if (list.some((item) => item.id === id)) {
            runtimeKey = key;
            bucket = list;
            break;
          }
        }
        if (!runtimeKey || !bucket) {
          if (!current.list.some((item) => item.id === id)) return;
          runtimeKey = getRuntimeKey();
          bucket = current.list;
        }
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, bucket.filter((item) => item.id !== id)));
      },

      clear: (ids) => {
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        const runtimeKey = getRuntimeKey();
        const current = get();
        const bucket = current.listsByRuntime[runtimeKey] ?? current.list;
        const next = bucket.filter((item) => !idSet.has(item.id));
        if (next.length === bucket.length) return;
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, next));
      },

      clearAll: () => {
        const runtimeKey = getRuntimeKey();
        const current = get();
        const bucket = current.listsByRuntime[runtimeKey] ?? current.list;
        if (bucket.length === 0) return;
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, []));
      },

      markSessionViewed: (sessionId) => {
        const current = get();
        const count = current.index.session.unseenCount[sessionId] ?? 0;
        if (count === 0) return;
        const runtimeKey = getRuntimeKey();
        const bucket = current.listsByRuntime[runtimeKey] ?? current.list;
        const next = bucket.map((item) => (
          item.session === sessionId && item.source === 'session' && !item.read
            ? { ...item, read: true }
            : item
        ));
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, next));
      },

      markProjectViewed: (directory) => {
        const current = get();
        const count = current.index.project.unseenCount[directory] ?? 0;
        if (count === 0) return;
        const runtimeKey = getRuntimeKey();
        const bucket = current.listsByRuntime[runtimeKey] ?? current.list;
        const next = bucket.map((item) => (
          item.directory === directory && item.source === 'session' && !item.read
            ? { ...item, read: true }
            : item
        ));
        set(commitRuntimeList(current.listsByRuntime, runtimeKey, next));
      },

      activateRuntime: (runtimeKey) => {
        const current = get();
        const list = current.listsByRuntime[runtimeKey] ?? [];
        set({
          list,
          index: buildNotificationIndex(list),
        });
      },

      sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
      sessionHasError: (sessionId) => get().index.session.unseenHasError[sessionId] ?? false,
      projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
      projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
    }),
    {
      name: 'openchamber-notifications.v1',
      storage: createDeferredSafeJSONStorage(),
      version: 1,
      partialize: (state): NotificationPersistState => ({ listsByRuntime: state.listsByRuntime }),
      merge: (persisted, current) => {
        const parsed = parseNotificationPersistState(persisted, getRuntimeKey());
        return {
          ...current,
          listsByRuntime: parsed.listsByRuntime,
          list: parsed.list,
          index: buildNotificationIndex(parsed.list),
        };
      },
    },
  ),
);

export function appendNotification(notification: NotificationAppendInput): NotificationRecord | null {
  return useNotificationStore.getState().append(notification);
}

export function markNotificationRead(id: string): void {
  useNotificationStore.getState().markRead(id);
}

export function markSessionViewed(sessionId: string): void {
  useNotificationStore.getState().markSessionViewed(sessionId);
}

export function activateNotificationRuntime(runtimeKey: string): void {
  useNotificationStore.getState().activateRuntime(runtimeKey);
}

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((state) => state.index.session.unseenCount[sessionId] ?? 0);
}

/** The newest error OpenCode reported for this session, viewed or not. */
export const latestSessionErrorFromList = (
  list: NotificationRecord[],
  sessionId: string,
): ErrorNotification | null => {
  if (!sessionId) return null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const notification = list[index];
    if (notification.session !== sessionId || notification.severity !== 'error') continue;
    if (notification.source !== 'session' && notification.source !== 'subtask') continue;
    return {
      session: notification.session,
      directory: notification.directory,
      time: notification.time,
      viewed: notification.read,
      type: 'error',
      error: notification.error ?? { name: null, message: notification.body || null },
    };
  }
  return null;
};

export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useNotificationStore((state) => latestSessionErrorFromList(state.list, sessionId));
}
