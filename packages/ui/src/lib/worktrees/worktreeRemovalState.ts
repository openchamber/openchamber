import { create } from 'zustand';
import { normalizePath } from '@/lib/pathNormalization';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type WorktreeRemovalState = {
  removingPaths: ReadonlySet<string>;
};

const useWorktreeRemovalStore = create<WorktreeRemovalState>(() => ({
  removingPaths: new Set(),
}));

const setRemoving = (path: string, removing: boolean): void => {
  const key = normalizePath(path);
  if (!key) return;
  const current = useWorktreeRemovalStore.getState().removingPaths;
  if (current.has(key) === removing) return;
  const next = new Set(current);
  if (removing) next.add(key);
  else next.delete(key);
  useWorktreeRemovalStore.setState({ removingPaths: next });
};

export const markWorktreeRemoving = (path: string): void => setRemoving(path, true);

export const clearWorktreeRemoval = (path: string): void => setRemoving(path, false);

const selectRemoving = (state: WorktreeRemovalState, path: string | null | undefined): boolean => {
  const key = normalizePath(path);
  return key ? state.removingPaths.has(key) : false;
};

export const isWorktreeRemoving = (path: string): boolean =>
  selectRemoving(useWorktreeRemovalStore.getState(), path);

export const useWorktreeRemoving = (path: string | null | undefined): boolean =>
  useWorktreeRemovalStore((state) => selectRemoving(state, path));

export const useRemovingWorktreePaths = (): ReadonlySet<string> => useWorktreeRemovalStore((state) => state.removingPaths);

subscribeRuntimeEndpointChanged(() => {
  if (useWorktreeRemovalStore.getState().removingPaths.size === 0) return;
  useWorktreeRemovalStore.setState({ removingPaths: new Set() });
});
