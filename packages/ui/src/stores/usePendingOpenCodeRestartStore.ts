import { create } from 'zustand';

export type PendingOpenCodeRestartScope =
  | 'agents'
  | 'providers'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'behavior'
  | 'cli'
  | 'all';

export type PendingOpenCodeRestartChange = {
  id: string;
  scope: PendingOpenCodeRestartScope;
  label?: string;
  recordedAt: number;
};

type PendingOpenCodeRestartState = {
  changes: PendingOpenCodeRestartChange[];
  isApplying: boolean;
  recordChange: (input: {
    scope: PendingOpenCodeRestartScope;
    id?: string;
    label?: string;
  }) => void;
  setApplying: (isApplying: boolean) => void;
  clear: () => void;
};

let changeSeq = 0;

const nextChangeId = (scope: PendingOpenCodeRestartScope, id?: string): string => {
  changeSeq += 1;
  return id?.trim() ? `${scope}:${id.trim()}:${changeSeq}` : `${scope}:${changeSeq}`;
};

export const usePendingOpenCodeRestartStore = create<PendingOpenCodeRestartState>((set) => ({
  changes: [],
  isApplying: false,

  recordChange: ({ scope, id, label }) => {
    const entry: PendingOpenCodeRestartChange = {
      id: nextChangeId(scope, id),
      scope,
      label,
      recordedAt: Date.now(),
    };
    set((state) => ({
      changes: [...state.changes, entry],
    }));
  },

  setApplying: (isApplying) => {
    set({ isApplying });
  },

  clear: () => {
    set({ changes: [], isApplying: false });
  },
}));

export const selectPendingOpenCodeRestartCount = (state: PendingOpenCodeRestartState): number =>
  state.changes.length;
