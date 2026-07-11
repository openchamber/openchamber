import { create } from 'zustand';

interface SessionMultiSelectState {
  enabled: boolean;
  selectedIds: Set<string>;
  scopeKey: string | null;
  anchorId: string | null;
}

interface SessionMultiSelectActions {
  enable: () => void;
  disable: () => void;
  toggleMode: () => void;
  toggleSelected: (id: string, scope: string | null, descendants?: string[]) => void;
  setRange: (fromId: string | null, toId: string, orderedIds: string[], scope: string | null, descendantsById?: Map<string, string[]>) => void;
  replaceAll: (ids: string[], scope: string | null) => void;
  clear: () => void;
  removeMany: (ids: string[]) => void;
}

type SessionMultiSelectStore = SessionMultiSelectState & SessionMultiSelectActions;

const expandWithDescendants = (ids: Iterable<string>, descendantsById?: Map<string, string[]>): string[] => {
  if (!descendantsById) {
    return Array.from(ids);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    const descendants = descendantsById.get(id);
    if (!descendants) continue;
    for (const d of descendants) {
      if (!seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out;
};

export const useSessionMultiSelectStore = create<SessionMultiSelectStore>()((set, get) => ({
  enabled: false,
  selectedIds: new Set<string>(),
  scopeKey: null,
  anchorId: null,

  enable: () => {
    if (get().enabled) return;
    set({ enabled: true });
  },

  disable: () => {
    set({ enabled: false, selectedIds: new Set(), scopeKey: null, anchorId: null });
  },

  toggleMode: () => {
    if (get().enabled) {
      set({ enabled: false, selectedIds: new Set(), scopeKey: null, anchorId: null });
    } else {
      set({ enabled: true });
    }
  },

  toggleSelected: (id, scope, descendants) => {
    const state = get();
    const nextIds = new Set(state.selectedIds);
    let nextScope = state.scopeKey;
    let nextAnchor = state.anchorId;

    const scopeChanged = scope !== null && state.scopeKey !== null && scope !== state.scopeKey;
    if (scopeChanged) {
      nextIds.clear();
      nextScope = scope;
      nextAnchor = null;
    } else if (nextScope === null && scope !== null) {
      nextScope = scope;
    }

    const toToggle = descendants && descendants.length > 0 ? [id, ...descendants] : [id];
    const isCurrentlySelected = nextIds.has(id);
    if (isCurrentlySelected) {
      for (const targetId of toToggle) {
        nextIds.delete(targetId);
      }
      if (nextAnchor === id) {
        nextAnchor = null;
      }
    } else {
      for (const targetId of toToggle) {
        nextIds.add(targetId);
      }
      nextAnchor = id;
    }

    if (nextIds.size === 0) {
      set({ selectedIds: nextIds, scopeKey: null, anchorId: null });
    } else {
      set({ selectedIds: nextIds, scopeKey: nextScope, anchorId: nextAnchor });
    }
  },

  setRange: (fromId, toId, orderedIds, scope, descendantsById) => {
    const state = get();
    if (orderedIds.length === 0) return;
    const effectiveFrom = fromId && orderedIds.includes(fromId) ? fromId : orderedIds[0];
    const start = orderedIds.indexOf(effectiveFrom);
    const end = orderedIds.indexOf(toId);
    if (start < 0 || end < 0) return;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    const slice = orderedIds.slice(lo, hi + 1);
    const expanded = expandWithDescendants(slice, descendantsById);

    const scopeChanged = scope !== null && state.scopeKey !== null && scope !== state.scopeKey;
    const baseIds = scopeChanged ? new Set<string>() : new Set(state.selectedIds);
    for (const id of expanded) {
      baseIds.add(id);
    }

    set({
      selectedIds: baseIds,
      scopeKey: scope ?? state.scopeKey,
      anchorId: effectiveFrom,
    });
  },

  replaceAll: (ids, scope) => {
    if (ids.length === 0) {
      set({ selectedIds: new Set(), scopeKey: null, anchorId: null });
      return;
    }
    set({ selectedIds: new Set(ids), scopeKey: scope, anchorId: ids[0] ?? null });
  },

  clear: () => {
    set({ selectedIds: new Set(), scopeKey: null, anchorId: null });
  },

  removeMany: (ids) => {
    const state = get();
    if (state.selectedIds.size === 0 || ids.length === 0) return;
    const next = new Set(state.selectedIds);
    for (const id of ids) {
      next.delete(id);
    }
    if (next.size === state.selectedIds.size) return;
    if (next.size === 0) {
      set({ selectedIds: next, scopeKey: null, anchorId: null });
    } else {
      set({ selectedIds: next });
    }
  },
}));
