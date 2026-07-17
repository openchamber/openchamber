import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

const RECENT_ORDER_STORAGE_KEY = 'oc.recent-order';

const readOrder = (storage: Storage): string[] => {
  try {
    const raw = storage.getItem(RECENT_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
};

const persistOrder = (storage: Storage, order: string[]): void => {
  try {
    storage.setItem(RECENT_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
};

type RecentOrderStore = {
  manualOrder: string[];
  reorder: (activeId: string, overId: string) => void;
  removeSession: (sessionId: string) => void;
  ensureInOrder: (sessionId: string) => void;
};

const safeStorage = getSafeStorage();

export const useRecentOrderStore = create<RecentOrderStore>((set, get) => ({
  manualOrder: readOrder(safeStorage),

  reorder: (activeId, overId) => {
    const current = get().manualOrder;
    const activeIndex = current.indexOf(activeId);
    const overIndex = current.indexOf(overId);

    let next: string[];

    if (activeIndex !== -1 && overIndex !== -1) {
      // Both in list: move activeId to the position of overId
      next = [...current];
      next.splice(activeIndex, 1);
      const insertAt = next.indexOf(overId);
      next.splice(insertAt, 0, activeId);
    } else if (activeIndex === -1 && overIndex !== -1) {
      // activeId not in list: insert before overId
      next = [...current];
      next.splice(overIndex, 0, activeId);
    } else if (activeIndex !== -1 && overIndex === -1) {
      // overId not in list: append activeId at end
      next = current.filter((id) => id !== activeId);
      next.push(activeId);
    } else {
      // Neither in list: create with both
      next = [...current, activeId, overId];
    }

    set({ manualOrder: next });
    persistOrder(safeStorage, next);
  },

  removeSession: (sessionId) => {
    const current = get().manualOrder;
    if (!current.includes(sessionId)) return;
    const next = current.filter((id) => id !== sessionId);
    set({ manualOrder: next });
    persistOrder(safeStorage, next);
  },

  ensureInOrder: (sessionId) => {
    const current = get().manualOrder;
    if (current.includes(sessionId)) return;
    const next = [...current, sessionId];
    set({ manualOrder: next });
    persistOrder(safeStorage, next);
  },
}));
