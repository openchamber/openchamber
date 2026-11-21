import React from 'react';
import { create } from 'zustand';
import type { WorktreeMetadata } from '@/types/worktree';

type MobileSidebarRowsState = {
  revealedKey: string | null;
  armedKey: string | null;
  renamingKey: string | null;
  setRevealed: (key: string, revealed: boolean) => void;
  arm: (key: string | null) => void;
  startRename: (key: string) => void;
  stopRename: () => void;
  forgetUnlisted: (isListed: (key: string) => boolean) => void;
  reset: () => void;
};

export const useMobileSidebarRowsStore = create<MobileSidebarRowsState>()((set) => ({
  revealedKey: null,
  armedKey: null,
  renamingKey: null,
  setRevealed: (key, revealed) => set((state) => (
    revealed ? { revealedKey: key, armedKey: null } : state.revealedKey === key ? { revealedKey: null, armedKey: null } : state
  )),
  arm: (key) => set({ armedKey: key }),
  startRename: (key) => set({ renamingKey: key, revealedKey: null, armedKey: null }),
  stopRename: () => set({ renamingKey: null }),
  forgetUnlisted: (isListed) => set((state) => {
    const revealedGone = state.revealedKey !== null && !isListed(state.revealedKey);
    const renamingGone = state.renamingKey !== null && !isListed(state.renamingKey);
    if (!revealedGone && !renamingGone) return state;
    return {
      revealedKey: revealedGone ? null : state.revealedKey,
      armedKey: revealedGone ? null : state.armedKey,
      renamingKey: renamingGone ? null : state.renamingKey,
    };
  }),
  reset: () => set({ revealedKey: null, armedKey: null, renamingKey: null }),
}));

export const useMobileRowSwipe = (key: string) => {
  const revealed = useMobileSidebarRowsStore((state) => state.revealedKey === key);
  const armed = useMobileSidebarRowsStore((state) => state.armedKey === key);
  const renaming = useMobileSidebarRowsStore((state) => state.renamingKey === key);
  return { revealed, armed, renaming };
};

export type MobileSidebarActions = {
  close: () => void;
  openProjectEdit: (projectId: string) => void;
  openNewWorktree: (projectId: string) => void;
  requestWorktreeDelete: (project: { id: string; path: string }, worktree: WorktreeMetadata) => void;
  openId: number;
};

const MobileSidebarActionsContext = React.createContext<MobileSidebarActions | null>(null);

export const MobileSidebarActionsProvider = MobileSidebarActionsContext.Provider;

export const useMobileSidebarActions = (): MobileSidebarActions => {
  const actions = React.useContext(MobileSidebarActionsContext);
  if (!actions) throw new Error('useMobileSidebarActions outside MobileSidebarActionsProvider');
  return actions;
};
