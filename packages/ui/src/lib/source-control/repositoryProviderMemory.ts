import { z } from 'zod';
import type { SourceControlProvider } from '@/lib/api/types';

/**
 * Which host each project lives on, remembered across reloads.
 *
 * A project does not move between GitHub and GitLab during a day, yet the
 * answer is only certain once its binding and the accounts have loaded. The
 * last certain answer stands in until then, for the project and every one of
 * its worktrees, so surfaces that name the host do not start as GitHub and
 * flip. Keyed by runtime and project path: another machine's project at the
 * same path is another project. A newer certain answer always replaces it.
 */
const STORAGE_KEY = 'openchamber.repositoryProvider.v1';
const MAX_ENTRIES = 500;

const storedMemory = z.array(z.tuple([z.string(), z.enum(['github', 'gitlab'])]));

const listeners = new Set<() => void>();
let memory: Map<string, SourceControlProvider> | null = null;

const readStorage = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const load = () => {
  if (memory) return memory;
  let entries: Array<[string, SourceControlProvider]> = [];
  try {
    const parsed = storedMemory.safeParse(JSON.parse(readStorage() ?? '[]'));
    if (parsed.success) entries = parsed.data;
  } catch {
    // A corrupt entry only costs the head start; the binding still answers.
  }
  memory = new Map(entries);
  return memory;
};

const entryKey = (runtimeKey: string, projectPath: string) => `${runtimeKey}\u0000${projectPath}`;

export const rememberedRepositoryProvider = (runtimeKey: string, projectPath: string | null): SourceControlProvider | null =>
  projectPath ? load().get(entryKey(runtimeKey, projectPath)) ?? null : null;

export const rememberRepositoryProvider = (runtimeKey: string, projectPath: string | null, provider: SourceControlProvider): void => {
  if (!projectPath) return;
  const current = load();
  const key = entryKey(runtimeKey, projectPath);
  if (current.get(key) === provider) return;
  // Re-inserted last, so the oldest entries are the ones trimmed.
  current.delete(key);
  current.set(key, provider);
  for (const stale of [...current.keys()].slice(0, Math.max(0, current.size - MAX_ENTRIES))) current.delete(stale);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...current]));
  } catch {
    // Storage full or blocked: the answer still holds for this session.
  }
  for (const listener of listeners) listener();
};

export const subscribeRepositoryProviderMemory = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
