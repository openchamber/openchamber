import { z } from 'zod';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { WorktreeMetadata } from '@/types/worktree';
import { checkoutHoldsDirectory } from './worktreePaths';

const STORAGE_KEY = 'oc.integrateCheckouts.v1';
const MAX_RUNTIMES = 8;

const projectsSchema = z.record(z.string(), z.object({ repositoryRoot: z.string().min(1), paths: z.array(z.string().min(1)) }));
const storedSchema = z.record(z.string(), projectsSchema.catch({})).catch({});

type ProjectCheckouts = { repositoryRoot: string; paths: readonly string[] };

const byRuntime = new Map<string, Map<string, ProjectCheckouts>>();

const readStored = (): z.infer<typeof storedSchema> => {
  try {
    return storedSchema.parse(JSON.parse(getSafeStorage().getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return {};
  }
};

const currentRuntime = (): string => getRuntimeKey().trim() || 'default';

const currentCheckouts = (): Map<string, ProjectCheckouts> => {
  const runtime = currentRuntime();
  let checkouts = byRuntime.get(runtime);
  if (!checkouts) {
    checkouts = new Map(Object.entries(readStored()[runtime] ?? {}));
    byRuntime.set(runtime, checkouts);
  }
  return checkouts;
};

const persistProjects = (changed: ReadonlyMap<string, ProjectCheckouts | null>): void => {
  const runtime = currentRuntime();
  const { [runtime]: stored, ...others } = readStored();
  const projects = new Map<string, ProjectCheckouts>(Object.entries(stored ?? {}));
  for (const [projectPath, entry] of changed) {
    if (entry) projects.set(projectPath, entry);
    else projects.delete(projectPath);
  }
  const kept = Object.entries(others).slice(-(MAX_RUNTIMES - 1));
  const next = projects.size > 0 ? [...kept, [runtime, Object.fromEntries(projects)]] : kept;
  try {
    getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    return;
  }
};

const samePaths = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((path, index) => path === right[index])
);

export const publishIntegrateCheckouts = (projectPath: string, repositoryRoot: string, paths: readonly string[]): boolean => {
  const checkouts = currentCheckouts();
  const changed = new Map<string, ProjectCheckouts | null>();
  const update = (project: string, next: readonly string[]): void => {
    const current = checkouts.get(project);
    if (samePaths(current?.paths ?? [], next) && (!current || current.repositoryRoot === repositoryRoot)) return;
    changed.set(project, next.length > 0 ? { repositoryRoot, paths: next } : null);
  };
  update(projectPath, paths);
  for (const [project, entry] of checkouts) {
    if (project !== projectPath && entry.repositoryRoot === repositoryRoot) update(project, entry.paths.filter((path) => paths.includes(path)));
  }
  if (changed.size === 0) return false;
  for (const [project, entry] of changed) {
    if (entry) checkouts.set(project, entry);
    else checkouts.delete(project);
  }
  persistProjects(changed);
  return true;
};

export const listIntegrateCheckouts = (): { path: string; projectPaths: string[] }[] => {
  const checkouts = new Map<string, string[]>();
  for (const [projectPath, { repositoryRoot, paths }] of currentCheckouts()) {
    for (const path of paths) {
      const known = checkouts.get(path) ?? [repositoryRoot];
      if (!known.includes(projectPath)) known.push(projectPath);
      checkouts.set(path, known);
    }
  }
  return [...checkouts].map(([path, projectPaths]) => ({ path, projectPaths }));
};

export const findIntegrateCheckout = (directory: string | null | undefined): { path: string; projectPaths: string[] } | null => {
  if (currentCheckouts().size === 0) return null;
  const target = normalizePath(directory);
  if (!target) return null;
  return listIntegrateCheckouts().find((checkout) => checkoutHoldsDirectory(checkout.path, target)) ?? null;
};

export const isCheckoutRoot = (worktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>, target: string | null): boolean => (
  target !== null && (findIntegrateCheckout(target)?.path === target
    || [...worktreesByProject.values()].some((worktrees) => worktrees.some((worktree) => normalizePath(worktree.path) === target)))
);
