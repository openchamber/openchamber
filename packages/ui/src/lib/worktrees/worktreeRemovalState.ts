import { create } from 'zustand';
import { normalizePath } from '@/lib/pathNormalization';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * Which worktrees this client is removing right now, so their sidebar rows can
 * show it from the user's confirmation until git answers. The row leaves the
 * list when the topology drops it; a failed removal clears the entry and the
 * row returns to normal. The state is local to this client: another window
 * removing the same worktree shows nothing until the topology refresh drops
 * the row.
 */
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

// Paths from the previous instance can collide with the next one's.
subscribeRuntimeEndpointChanged(() => {
  if (useWorktreeRemovalStore.getState().removingPaths.size === 0) return;
  useWorktreeRemovalStore.setState({ removingPaths: new Set() });
});
