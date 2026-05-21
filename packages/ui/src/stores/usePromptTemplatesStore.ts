import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { PromptTemplate } from '@/types/prompt-template';

interface PromptTemplatesStore {
  templates: PromptTemplate[];
  isLoading: boolean;
  selectedTemplateId: string | null;

  setSelectedTemplate: (id: string | null) => void;
  loadTemplates: () => Promise<boolean>;
  createTemplate: (id: string, name: string, body: string) => Promise<boolean>;
  updateTemplate: (id: string, updates: { name?: string; body?: string }) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<boolean>;
  getTemplateById: (id: string) => PromptTemplate | undefined;
}

const TEMPLATES_LOAD_CACHE_TTL_MS = 5000;
let lastLoadedAt = 0;
let loadInFlight: Promise<boolean> | null = null;

export const usePromptTemplatesStore = create<PromptTemplatesStore>()(
  devtools(
    (set, get) => ({
      templates: [],
      isLoading: false,
      selectedTemplateId: null,

      setSelectedTemplate: (id: string | null) => {
        set({ selectedTemplateId: id });
      },

      loadTemplates: async () => {
        const now = Date.now();
        if (get().templates.length > 0 && now - lastLoadedAt < TEMPLATES_LOAD_CACHE_TTL_MS) {
          return true;
        }

        if (loadInFlight) {
          return loadInFlight;
        }

        const request = (async () => {
          set({ isLoading: true });
          try {
            const response = await fetch('/api/config/prompt-templates', {
              headers: { 'Cache-Control': 'no-cache' },
            });
            if (!response.ok) {
              throw new Error('Failed to load prompt templates');
            }
            const templates: PromptTemplate[] = await response.json();
            set({ templates, isLoading: false });
            lastLoadedAt = Date.now();
            return true;
          } catch (error) {
            console.error('[PromptTemplatesStore] Failed to load:', error);
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

      createTemplate: async (id: string, name: string, body: string) => {
        try {
          const response = await fetch(`/api/config/prompt-templates/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, body }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || 'Failed to create prompt template');
          }
          lastLoadedAt = 0;
          await get().loadTemplates();
          return true;
        } catch (error) {
          console.error('[PromptTemplatesStore] Failed to create:', error);
          return false;
        }
      },

      updateTemplate: async (id: string, updates: { name?: string; body?: string }) => {
        try {
          const response = await fetch(`/api/config/prompt-templates/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || 'Failed to update prompt template');
          }
          lastLoadedAt = 0;
          await get().loadTemplates();
          return true;
        } catch (error) {
          console.error('[PromptTemplatesStore] Failed to update:', error);
          return false;
        }
      },

      deleteTemplate: async (id: string) => {
        try {
          const response = await fetch(`/api/config/prompt-templates/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || 'Failed to delete prompt template');
          }
          if (get().selectedTemplateId === id) {
            set({ selectedTemplateId: null });
          }
          lastLoadedAt = 0;
          await get().loadTemplates();
          return true;
        } catch (error) {
          console.error('[PromptTemplatesStore] Failed to delete:', error);
          return false;
        }
      },

      getTemplateById: (id: string) => {
        return get().templates.find((t) => t.id === id);
      },
    }),
    { name: 'prompt-templates-store' },
  ),
);
