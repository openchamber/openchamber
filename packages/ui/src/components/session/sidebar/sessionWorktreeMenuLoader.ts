import { create } from 'zustand';
import type { StartSessionWorktreeMenuLoadArgs, StartSessionWorktreeMenuLoadResult } from './sessionWorktreeMenu';

type SessionWorktreeMenuLoader = (args: StartSessionWorktreeMenuLoadArgs) => StartSessionWorktreeMenuLoadResult;

export const useSessionWorktreeMenuLoader = create<{ load: SessionWorktreeMenuLoader | null }>(() => ({ load: null }));
