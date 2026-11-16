import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Snippet } from '@/types/snippet';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export type SnippetScope = 'global' | 'project';

export interface SnippetDraft {
  name: string;
  scope: SnippetScope;
  content?: string;
  aliases?: string[];
  description?: string;
}

type SnippetWriteResult = { ok: true } | { ok: false; reason: 'taken' | 'failed' };

export interface SnippetQuickCreate {
  name?: string;
  content: string;
  onSaved?: (name: string) => void;
}

interface SnippetsStore {
  snippets: Snippet[];
  isLoading: boolean;
  selectedSnippetName: string | null;
  snippetDraft: SnippetDraft | null;
  hasUnsavedChanges: boolean;
  quickCreate: SnippetQuickCreate | null;

  setSelectedSnippet: (name: string | null) => void;
  setSnippetDraft: (draft: SnippetDraft | null) => void;
  setHasUnsavedChanges: (value: boolean) => void;
  openQuickCreate: (request: SnippetQuickCreate) => void;
  closeQuickCreate: () => void;
  loadSnippets: () => Promise<boolean>;
  createSnippet: (name: string, content: string, options?: { aliases?: string[]; description?: string; scope?: SnippetScope }) => Promise<SnippetWriteResult>;
  updateSnippet: (name: string, updates: { name?: string; scope?: SnippetScope; content?: string; aliases?: string[]; description?: string }) => Promise<SnippetWriteResult>;
  deleteSnippet: (name: string) => Promise<boolean>;
  expandText: (text: string) => Promise<string>;
  previewSnippet: (content: string) => Promise<string>;
  getSnippetByName: (name: string) => Snippet | undefined;
}

const writeFailure = (status: number): SnippetWriteResult => ({ ok: false, reason: status === 409 ? 'taken' : 'failed' });

const SNIPPETS_LOAD_CACHE_TTL_MS = 5000;
let lastLoadedAt = 0;
let registryGeneration = 0;
let loadInFlight: { generation: number; promise: Promise<boolean> } | null = null;
let registryDirectory: string | null | undefined;

const isRegistryCurrent = (directory: string | null): boolean => (
  registryDirectory === directory && Date.now() - lastLoadedAt < SNIPPETS_LOAD_CACHE_TTL_MS
);

const invalidateRegistry = () => {
  registryGeneration += 1;
  lastLoadedAt = 0;
  registryDirectory = undefined;
};

const SNIPPET_TOKEN = /#([a-z0-9_-]+)/gi;

const namesKnownSnippet = (text: string, snippets: readonly Snippet[]): boolean => {
  const triggers = new Set<string>();
  for (const snippet of snippets) {
    triggers.add(snippet.name.toLowerCase());
    for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
  }
  for (const match of text.matchAll(SNIPPET_TOKEN)) {
    if (triggers.has(match[1].toLowerCase())) return true;
  }
  return false;
};

const getRequestDirectory = (): string | null => {
  try {
    const currentDirectory = useDirectoryStore.getState().currentDirectory;
    if (currentDirectory?.trim()) return currentDirectory.trim();
    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) return clientDir.trim();
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) return activeProject.path.trim();
  } catch (error) {
    console.warn('[SnippetsStore] Error resolving config directory:', error);
  }
  return null;
};

const requestExpansion = async (directory: string | null, body: { text: string } | { content: string }): Promise<string | undefined> => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (directory) headers.set('x-opencode-directory', directory);
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/snippets/expand${queryParams}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Failed to expand snippets');
  return (await response.json()).text;
};

export const useSnippetsStore = create<SnippetsStore>()(
  devtools(
    (set, get) => ({
      snippets: [],
      isLoading: false,
      selectedSnippetName: null,
      snippetDraft: null,
      hasUnsavedChanges: false,
      quickCreate: null,

      setSelectedSnippet: (name) => set({ selectedSnippetName: name }),
      setSnippetDraft: (draft) => set({ snippetDraft: draft }),
      setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),
      openQuickCreate: (request) => set({ quickCreate: request }),
      closeQuickCreate: () => set({ quickCreate: null }),

      loadSnippets: async () => {
        const directory = getRequestDirectory();
        if (get().snippets.length > 0 && isRegistryCurrent(directory)) return true;
        if (loadInFlight?.generation === registryGeneration) return loadInFlight.promise;

        const generation = registryGeneration;
        const request = (async (): Promise<boolean> => {
          set({ isLoading: true });
          try {
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            const response = await runtimeFetch(`/api/config/snippets${queryParams}`, {
              headers: { 'Cache-Control': 'no-cache', ...(directory ? { 'x-opencode-directory': directory } : {}) },
              signal: new AbortController().signal,
            });
            if (!response.ok) throw new Error('Failed to load snippets');
            const snippets: Snippet[] = await response.json();
            if (generation !== registryGeneration) return get().loadSnippets();
            set({ snippets, isLoading: false });
            lastLoadedAt = Date.now();
            registryDirectory = directory;
            return true;
          } catch (error) {
            if (generation !== registryGeneration) return get().loadSnippets();
            console.error('[SnippetsStore] Failed to load:', error);
            set({ isLoading: false });
            return false;
          }
        })();

        const entry = { generation, promise: request };
        loadInFlight = entry;
        try {
          return await request;
        } finally {
          if (loadInFlight === entry) loadInFlight = null;
        }
      },

      createSnippet: async (name, content, options = {}) => {
        try {
          const directory = getRequestDirectory();
          const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
          const response = await runtimeFetch(`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(directory ? { 'x-opencode-directory': directory } : {}) },
            body: JSON.stringify({ content, aliases: options.aliases, description: options.description, scope: options.scope }),
          });
          if (!response.ok) {
            console.error('[SnippetsStore] Failed to create:', (await response.json().catch(() => null))?.error);
            return writeFailure(response.status);
          }
          invalidateRegistry();
          await get().loadSnippets();
          return { ok: true };
        } catch (error) {
          console.error('[SnippetsStore] Failed to create:', error);
          return { ok: false, reason: 'failed' };
        }
      },

      updateSnippet: async (name, updates) => {
        try {
          const directory = getRequestDirectory();
          const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
          const response = await runtimeFetch(`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...(directory ? { 'x-opencode-directory': directory } : {}) },
            body: JSON.stringify(updates),
          });
          if (!response.ok) {
            console.error('[SnippetsStore] Failed to update:', (await response.json().catch(() => null))?.error);
            return writeFailure(response.status);
          }
          const payload: { snippet?: Snippet } = await response.json().catch(() => ({}));
          const saved = payload.snippet;
          if (saved) {
            set((state) => ({
              snippets: state.snippets.map((item) => (item.name === name ? saved : item)),
              selectedSnippetName: state.selectedSnippetName === name ? saved.name : state.selectedSnippetName,
            }));
          }
          invalidateRegistry();
          await get().loadSnippets();
          return { ok: true };
        } catch (error) {
          console.error('[SnippetsStore] Failed to update:', error);
          return { ok: false, reason: 'failed' };
        }
      },

      deleteSnippet: async (name) => {
        try {
          const directory = getRequestDirectory();
          const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
          const response = await runtimeFetch(`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`, {
            method: 'DELETE',
            headers: directory ? { 'x-opencode-directory': directory } : undefined,
          });
          if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Failed to delete snippet');
          if (get().selectedSnippetName === name) set({ selectedSnippetName: null });
          invalidateRegistry();
          await get().loadSnippets();
          return true;
        } catch (error) {
          console.error('[SnippetsStore] Failed to delete:', error);
          return false;
        }
      },

      expandText: async (text) => {
        if (!/#[a-z0-9_-]+/i.test(text)) return text;
        const directory = getRequestDirectory();
        if (isRegistryCurrent(directory) && !namesKnownSnippet(text, get().snippets)) return text;
        return (await requestExpansion(directory, { text })) ?? text;
      },

      previewSnippet: async (content) => (await requestExpansion(getRequestDirectory(), { content })) ?? '',

      getSnippetByName: (name) => get().snippets.find((snippet) => snippet.name === name || snippet.aliases.includes(name)),
    }),
    { name: 'snippets-store' },
  ),
);
