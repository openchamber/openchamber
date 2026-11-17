import { create } from 'zustand';
import type { StartSessionWorktreeMenuLoadArgs, StartSessionWorktreeMenuLoadResult } from './sessionWorktreeMenu';

type SessionWorktreeMenuLoader = (args: StartSessionWorktreeMenuLoadArgs) => StartSessionWorktreeMenuLoadResult;

export const useSessionWorktreeMenuLoader = create<{ load: SessionWorktreeMenuLoader | null }>(() => ({ load: null }));

export const publishSessionWorktreeMenuLoader = (load: SessionWorktreeMenuLoader): (() => void) => {
  useSessionWorktreeMenuLoader.setState({ load });
  return () => {
    if (useSessionWorktreeMenuLoader.getState().load === load) useSessionWorktreeMenuLoader.setState({ load: null });
  };
};
