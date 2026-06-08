import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Snippet } from '@/types/snippet';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useProjectsStore } from '@/stores/useProjectsStore';

export type SnippetScope = 'global' | 'project';

export interface SnippetDraft {
  name: string;
  scope: SnippetScope;
  content?: string;
  aliases?: string[];
  description?: string;
}

interface SnippetsStore {
  snippets: Snippet[];
  isLoading: boolean;
  selectedSnippetName: string | null;
  snippetDraft: SnippetDraft | null;

  setSelectedSnippet: (name: string | null) => void;
  setSnippetDraft: (draft: SnippetDraft | null) => void;
  loadSnippets: () => Promise<boolean>;
  createSnippet: (name: string, content: string, options?: { aliases?: string[]; description?: string; scope?: SnippetScope }) => Promise<boolean>;
  updateSnippet: (name: string, updates: { content?: string; aliases?: string[]; description?: string }) => Promise<boolean>;
  deleteSnippet: (name: string) => Promise<boolean>;
  expandText: (text: string) => Promise<string>;
  getSnippetByName: (name: string) => Snippet | undefined;
}

const SNIPPETS_LOAD_CACHE_TTL_MS = 5000;
let lastLoadedAt = 0;
let loadInFlight: Promise<boolean> | null = null;

const getRequestDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) return activeProject.path.trim();
    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) return clientDir.trim();
  } catch (error) {
    console.warn('[SnippetsStore] Error resolving config directory:', error);
  }
  return null;
};

export const useSnippetsStore = create<SnippetsStore>()(
  devtools(
    (set, get) => ({
      snippets: [],
      isLoading: false,
      selectedSnippetName: null,
      snippetDraft: null,

      setSelectedSnippet: (name) => set({ selectedSnippetName: name }),
      setSnippetDraft: (draft) => set({ snippetDraft: draft }),

      loadSnippets: async () => {
        const now = Date.now();
        if (get().snippets.length > 0 && now - lastLoadedAt < SNIPPETS_LOAD_CACHE_TTL_MS) return true;
        if (loadInFlight) return loadInFlight;

        const request = (async () => {
          set({ isLoading: true });
          try {
            const directory = getRequestDirectory();
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            const response = await runtimeFetch(`/api/config/snippets${queryParams}`, {
              headers: { 'Cache-Control': 'no-cache', ...(directory ? { 'x-opencode-directory': directory } : {}) },
            });
            if (!response.ok) throw new Error('Failed to load snippets');
            const snippets: Snippet[] = await response.json();
            set({ snippets, isLoading: false });
            lastLoadedAt = Date.now();
            return true;
          } catch (error) {
            console.error('[SnippetsStore] Failed to load:', error);
            set({ isLoading: false });
            return false;
          }
        })();

        loadInFlight = request;
        try {
          return await request;
        } finally {
          loadInFlight = null;
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
            const payload = await response.json().catch(() => null);
            if (response.status === 409) {
              return await get().updateSnippet(name, { content, aliases: options.aliases, description: options.description });
            }
            throw new Error(payload?.error || 'Failed to create snippet');
          }
          lastLoadedAt = 0;
          await get().loadSnippets();
          return true;
        } catch (error) {
          console.error('[SnippetsStore] Failed to create:', error);
          return false;
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
          if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Failed to update snippet');
          lastLoadedAt = 0;
          await get().loadSnippets();
          return true;
        } catch (error) {
          console.error('[SnippetsStore] Failed to update:', error);
          return false;
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
          lastLoadedAt = 0;
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
        const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const response = await runtimeFetch(`/api/config/snippets/expand${queryParams}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(directory ? { 'x-opencode-directory': directory } : {}) },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Failed to expand snippets');
        return (await response.json()).text ?? text;
      },

      getSnippetByName: (name) => get().snippets.find((snippet) => snippet.name === name || snippet.aliases.includes(name)),
    }),
    { name: 'snippets-store' },
  ),
);
