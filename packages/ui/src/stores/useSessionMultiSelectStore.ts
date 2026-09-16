import { create } from 'zustand';

interface SessionMultiSelectState {
  enabled: boolean;
  selectedIds: Set<string>;
  scopeKey: string | null;
  /** Session id retained for callers that only need the selected API identity. */
  anchorId: string | null;
  /** Rendered occurrence identity used to resolve a shift range. */
  anchorRowKey: string | null;
}

type SessionSelectionRow = {
  id: string;
  rowKey: string;
  scopeKey: string | null;
};

interface SessionMultiSelectActions {
  enable: () => void;
  disable: () => void;
  toggleMode: () => void;
  toggleSelected: (id: string, scope: string | null, descendants?: string[], rowKey?: string) => void;
  setRange: (fromRowKey: string | null, toRowKey: string, orderedRows: readonly SessionSelectionRow[], scope: string | null, descendantsById?: Map<string, string[]>) => void;
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
  anchorRowKey: null,

  enable: () => {
    if (get().enabled) return;
    set({ enabled: true });
  },

  disable: () => {
    set({ enabled: false, selectedIds: new Set(), scopeKey: null, anchorId: null, anchorRowKey: null });
  },

  toggleMode: () => {
    if (get().enabled) {
      set({ enabled: false, selectedIds: new Set(), scopeKey: null, anchorId: null, anchorRowKey: null });
    } else {
      set({ enabled: true });
    }
  },

  toggleSelected: (id, scope, descendants, rowKey) => {
    const state = get();
    const nextIds = new Set(state.selectedIds);
    let nextScope = state.scopeKey;
    let nextAnchorId = state.anchorId;
    let nextAnchorRowKey = state.anchorRowKey;

    const scopeChanged = state.selectedIds.size > 0 && scope !== state.scopeKey;
    if (scopeChanged) {
      nextIds.clear();
      nextScope = scope;
      nextAnchorId = null;
      nextAnchorRowKey = null;
    } else if (nextScope === null && scope !== null) {
      nextScope = scope;
    }

    const toToggle = descendants && descendants.length > 0 ? [id, ...descendants] : [id];
    const isCurrentlySelected = nextIds.has(id);
    if (isCurrentlySelected) {
      for (const targetId of toToggle) {
        nextIds.delete(targetId);
      }
      if (nextAnchorId === id) {
        nextAnchorId = null;
        nextAnchorRowKey = null;
      }
    } else {
      for (const targetId of toToggle) {
        nextIds.add(targetId);
      }
      nextAnchorId = id;
      nextAnchorRowKey = rowKey ?? id;
    }

    if (nextIds.size === 0) {
      set({ selectedIds: nextIds, scopeKey: null, anchorId: null, anchorRowKey: null });
    } else {
      set({ selectedIds: nextIds, scopeKey: nextScope, anchorId: nextAnchorId, anchorRowKey: nextAnchorRowKey });
    }
  },

  setRange: (fromRowKey, toRowKey, orderedRows, scope, descendantsById) => {
    const state = get();
    const scopedRows = orderedRows.filter((row) => row.scopeKey === scope);
    if (scopedRows.length === 0) return;
    const effectiveFrom = scopedRows.find((row) => row.rowKey === fromRowKey) ?? scopedRows[0];
    const start = scopedRows.indexOf(effectiveFrom);
    const end = scopedRows.findIndex((row) => row.rowKey === toRowKey);
    if (start < 0 || end < 0) return;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    const slice = scopedRows.slice(lo, hi + 1).map((row) => row.id);
    const expanded = expandWithDescendants(slice, descendantsById);

    const scopeChanged = state.selectedIds.size > 0 && scope !== state.scopeKey;
    const baseIds = scopeChanged ? new Set<string>() : new Set(state.selectedIds);
    for (const id of expanded) {
      baseIds.add(id);
    }

    set({
      selectedIds: baseIds,
      scopeKey: scope,
      anchorId: effectiveFrom.id,
      anchorRowKey: effectiveFrom.rowKey,
    });
  },

  replaceAll: (ids, scope) => {
    if (ids.length === 0) {
      set({ selectedIds: new Set(), scopeKey: null, anchorId: null, anchorRowKey: null });
      return;
    }
    set({ selectedIds: new Set(ids), scopeKey: scope, anchorId: ids[0] ?? null, anchorRowKey: null });
  },

  clear: () => {
    set({ selectedIds: new Set(), scopeKey: null, anchorId: null, anchorRowKey: null });
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
      set({ selectedIds: next, scopeKey: null, anchorId: null, anchorRowKey: null });
    } else if (state.anchorId !== null && !next.has(state.anchorId)) {
      set({ selectedIds: next, anchorId: null, anchorRowKey: null });
    } else {
      set({ selectedIds: next });
    }
  },
}));
