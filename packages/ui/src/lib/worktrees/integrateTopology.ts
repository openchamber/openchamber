import { normalizePath } from '@/lib/pathNormalization';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { findIntegrateCheckout, listIntegrateCheckouts, publishIntegrateCheckouts } from './integrateCheckouts';

export const publishProjectIntegrateCheckouts = (projectPath: string, repositoryRoot: string, paths: readonly string[]): void => {
  if (!publishIntegrateCheckouts(projectPath, normalizePath(repositoryRoot) ?? repositoryRoot, paths)) return;
  useSessionUIStore.setState((state) => ({ availableWorktreesByProject: new Map(state.availableWorktreesByProject) }));
};

export const addIntegrateCheckout = (projectPath: string, repositoryRoot: string, checkout: string): boolean => {
  const path = normalizePath(checkout);
  if (!path || findIntegrateCheckout(path)) return false;
  const root = normalizePath(repositoryRoot) ?? repositoryRoot;
  const known = listIntegrateCheckouts().filter((entry) => entry.projectPaths.includes(root)).map((entry) => entry.path);
  publishProjectIntegrateCheckouts(projectPath, repositoryRoot, [...known, path]);
  return true;
};
