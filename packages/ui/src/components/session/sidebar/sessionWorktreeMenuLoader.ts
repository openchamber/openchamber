import { create } from 'zustand';
import type { StartSessionWorktreeMenuLoadArgs, StartSessionWorktreeMenuLoadResult } from './sessionWorktreeMenu';

type SessionWorktreeMenuLoader = (args: StartSessionWorktreeMenuLoadArgs) => StartSessionWorktreeMenuLoadResult;

/**
 * The sidebar's loader for Move to worktree targets, for session menus outside
 * the sidebar (the header's). The sidebar owns the worktree topology it reads,
 * and stays mounted while closed; until it publishes, those menus leave the
 * submenu out.
 */
export const useSessionWorktreeMenuLoader = create<{ load: SessionWorktreeMenuLoader | null }>(() => ({ load: null }));

/** Publishes `load`; the returned cleanup withdraws it unless a newer one replaced it. */
export const publishSessionWorktreeMenuLoader = (load: SessionWorktreeMenuLoader): (() => void) => {
  useSessionWorktreeMenuLoader.setState({ load });
  return () => {
    if (useSessionWorktreeMenuLoader.getState().load === load) useSessionWorktreeMenuLoader.setState({ load: null });
  };
};
