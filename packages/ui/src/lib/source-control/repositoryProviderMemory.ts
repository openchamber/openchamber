import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import type { SourceControlProvider } from '@/lib/api/types';

const STORAGE_KEY = 'openchamber.repositoryProvider.v1';
const MAX_ENTRIES = 500;

const storedMemory = z.array(z.tuple([z.string(), sourceControlProviderIdSchema]).nullable().catch(null))
  .transform((entries) => entries.filter((entry) => entry !== null));

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
  // oxlint-disable-next-line no-empty
  } catch {
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
  current.delete(key);
  current.set(key, provider);
  for (const stale of [...current.keys()].slice(0, Math.max(0, current.size - MAX_ENTRIES))) current.delete(stale);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...current]));
  // oxlint-disable-next-line no-empty
  } catch {
  }
  for (const listener of listeners) listener();
};

export const subscribeRepositoryProviderMemory = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
