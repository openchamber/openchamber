import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Snippet } from '@/types/snippet';
import { opencodeClient } from '@/lib/opencode/client';
import { fetchSnippets, createSnippet as apiCreateSnippet, updateSnippet as apiUpdateSnippet, deleteSnippet as apiDeleteSnippet, expandSnippets } from '@/lib/api/configApi';
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
            const snippets = await fetchSnippets(directory);
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
          const result = await apiCreateSnippet(name, { content, aliases: options.aliases, description: options.description, scope: options.scope }, directory);
          if (!result.ok) {
            return await get().updateSnippet(name, { content, aliases: options.aliases, description: options.description });
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
          const result = await apiUpdateSnippet(name, updates, directory);
          if (!result.ok) throw new Error(result.error || 'Failed to update snippet');
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
          const result = await apiDeleteSnippet(name, directory);
          if (!result.ok) throw new Error(result.error || 'Failed to delete snippet');
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
        return await expandSnippets(text, directory);
      },

      getSnippetByName: (name) => get().snippets.find((snippet) => snippet.name === name || snippet.aliases.includes(name)),
    }),
    { name: 'snippets-store' },
  ),
);
