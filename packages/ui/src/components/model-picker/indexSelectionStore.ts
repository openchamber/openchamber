export type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

export const createIndexSelectionStore = (): IndexSelectionStore => {
  let value = 0;
  const listeners = new Set<() => void>();
  const listenersByIndex = new Map<number, Set<() => void>>();
  const notify = (index: number) => {
    const listeners = listenersByIndex.get(index);
    if (!listeners) return;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeIndex: (index, listener) => {
      let listeners = listenersByIndex.get(index);
      if (!listeners) {
        listeners = new Set();
        listenersByIndex.set(index, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByIndex.delete(index);
      };
    },
    set: (nextValue) => {
      if (value === nextValue) return;
      const previousValue = value;
      value = nextValue;
      notify(previousValue);
      notify(nextValue);
      for (const listener of listeners) listener();
    },
  };
};
