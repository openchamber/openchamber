import { create } from 'zustand';
import { z } from 'zod';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import type {
  ChangeRequestContext,
  SourceControlAPI,
  SourceControlReadContext,
} from '@/lib/api/types';

const CONTEXT_TTL_MS = 30_000;
const CONTEXT_MAX_ENTRIES = 20;
const contextKeySchema = z.tuple([
  z.string(), z.string(), z.string(), z.string(), z.string(),
  z.number(), z.string(), z.string(), z.number(), z.string(),
]);

export const getChangeRequestContextKey = (
  context: SourceControlReadContext,
  number: number,
  project?: { owner: string; name: string },
): string => JSON.stringify([
  getRuntimeKey(), ...sourceControlReadContextParts(context), number,
  project ? `${project.owner}/${project.name}` : '',
]);

const parseContextKey = (key: string): {
  runtimeKey: string;
  provider: string;
  instance: string;
  accountId: string;
  repositoryId: string;
  bindingRevision: number;
  directory: string;
  primaryRemote: string;
  number: number;
} | null => {
  try {
    const parsed = contextKeySchema.safeParse(JSON.parse(key));
    if (!parsed.success) return null;
    const [runtimeKey, provider, instance, accountId, repositoryId, bindingRevision, directory, primaryRemote, number] = parsed.data;
    return { runtimeKey, provider, instance, accountId, repositoryId, bindingRevision, directory, primaryRemote, number };
  } catch {
    return null;
  }
};

type ContextEntry = {
  result: ChangeRequestContext | null;
  hasCIDetails: boolean;
  fetchedAt: number;
  isLoading: boolean;
  error: string | null;
};

type EnsureOptions = {
  includeCIDetails?: boolean;
  project?: { owner: string; name: string };
  force?: boolean;
};

type ChangeRequestContextStore = {
  entries: Record<string, ContextEntry>;
  ensure: (
    sourceControl: Pick<SourceControlAPI, 'changeRequestContext'>,
    context: SourceControlReadContext,
    number: number,
    options?: EnsureOptions,
  ) => Promise<ChangeRequestContext | null>;
  invalidate: (context: SourceControlReadContext, number?: number) => void;
  resetForRuntimeSwitch: () => void;
};

const createEntry = (): ContextEntry => ({
  result: null,
  hasCIDetails: false,
  fetchedAt: 0,
  isLoading: false,
  error: null,
});

type InFlightRequest = {
  promise: Promise<ChangeRequestContext | null>;
  token: symbol;
};

const inFlight = new Map<string, InFlightRequest>();
const activeRequestTokens = new Map<string, symbol>();
let generation = 0;

const boundEntries = (entries: Record<string, ContextEntry>, retainedKey: string): Record<string, ContextEntry> => {
  const all = Object.entries(entries);
  if (all.length <= CONTEXT_MAX_ENTRIES) return entries;
  const protectedEntries = all.filter(([key, entry]) => key === retainedKey || entry.isLoading);
  const available = Math.max(0, CONTEXT_MAX_ENTRIES - protectedEntries.length);
  const recentEntries = all
    .filter(([key, entry]) => key !== retainedKey && !entry.isLoading)
    .sort(([, left], [, right]) => right.fetchedAt - left.fetchedAt)
    .slice(0, available);
  return Object.fromEntries([...protectedEntries, ...recentEntries]);
};

export const useChangeRequestContextStore = create<ChangeRequestContextStore>()((set, get) => ({
  entries: {},
  ensure: async (sourceControl, context, number, options) => {
    const key = getChangeRequestContextKey(context, number, options?.project);
    const includeCIDetails = options?.includeCIDetails ?? false;
    const existing = get().entries[key];
    const isFresh = existing
      && existing.result
      && Date.now() - existing.fetchedAt < CONTEXT_TTL_MS
      && (existing.hasCIDetails || !includeCIDetails);
    if (!options?.force && isFresh) return existing.result;

    const detailKey = `${key}::details`;
    const requestKey = includeCIDetails ? detailKey : `${key}::plain`;
    const pending = inFlight.get(detailKey) ?? (includeCIDetails ? undefined : inFlight.get(requestKey));
    if (pending && !options?.force) return pending.promise;

    const requestGeneration = generation;
    const requestToken = Symbol(requestKey);
    activeRequestTokens.set(key, requestToken);
    const request = (async (): Promise<ChangeRequestContext | null> => {
      set((state) => ({
        entries: boundEntries({
          ...state.entries,
          [key]: { ...(state.entries[key] ?? createEntry()), isLoading: true, error: null },
        }, key),
      }));
      try {
        const result = await sourceControl.changeRequestContext(context, number, {
          includeDiff: false,
          includeCIDetails,
          project: options?.project,
        });
        if (requestGeneration !== generation || activeRequestTokens.get(key) !== requestToken) return null;
        set((state) => ({
          entries: boundEntries({
            ...state.entries,
            [key]: { result, hasCIDetails: includeCIDetails, fetchedAt: Date.now(), isLoading: false, error: null },
          }, key),
        }));
        return result;
      } catch (error) {
        if (requestGeneration !== generation || activeRequestTokens.get(key) !== requestToken) return null;
        const message = error instanceof Error ? error.message : 'Failed to load change request context';
        set((state) => ({
          entries: boundEntries({
            ...state.entries,
            [key]: { ...(state.entries[key] ?? createEntry()), isLoading: false, error: message },
          }, key),
        }));
        return null;
      } finally {
        if (activeRequestTokens.get(key) === requestToken) activeRequestTokens.delete(key);
        if (inFlight.get(requestKey)?.token === requestToken) {
          inFlight.delete(requestKey);
        }
      }
    })();
    inFlight.set(requestKey, { promise: request, token: requestToken });
    return request;
  },
  invalidate: (context, number) => {
    const matchesContext = (key: string): boolean => {
      const parsed = parseContextKey(key);
      return Boolean(
        parsed
        && parsed.provider === context.provider
        && parsed.instance === context.instance
        && parsed.accountId === context.accountId
        && parsed.repositoryId === context.repositoryId
        && parsed.bindingRevision === context.bindingRevision
        && parsed.directory === context.directory
        && parsed.primaryRemote === context.primaryRemote
        && (number == null || parsed.number === number),
      );
    };
    for (const key of activeRequestTokens.keys()) {
      if (!matchesContext(key)) continue;
      activeRequestTokens.delete(key);
      for (const requestKey of inFlight.keys()) {
        if (!requestKey.startsWith(`${key}::`)) continue;
        inFlight.delete(requestKey);
      }
    }
    set((state) => {
      const next: Record<string, ContextEntry> = {};
      for (const [key, entry] of Object.entries(state.entries)) {
        if (!matchesContext(key)) next[key] = entry;
      }
      return { entries: next };
    });
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight.clear();
    activeRequestTokens.clear();
    set({ entries: {} });
  },
}));
