import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface OhMyOpencodeCategory {
  model: string;
  variant?: string;
}

interface OhMyOpencodeState {
  installed: boolean;
  categories: Record<string, OhMyOpencodeCategory>;
  agents: Record<string, OhMyOpencodeCategory>;
  isLoading: boolean;
  isLoaded: boolean;
  // Actions
  load: () => Promise<void>;
}

export const useOhMyOpencodeStore = create<OhMyOpencodeState>()(
  devtools(
    (set, get) => ({
      installed: false,
      categories: {},
      agents: {},
      isLoading: false,
      isLoaded: false,

      load: async () => {
        if (get().isLoading) return;
        set({ isLoading: true });
        try {
          const response = await fetch("/api/config/oh-my-opencode");
          if (!response.ok) {
            set({ installed: false, categories: {}, agents: {}, isLoading: false, isLoaded: true });
            return;
          }
          const data = await response.json();
          set({
            installed: !!data.installed,
            categories: data.categories || {},
            agents: data.agents || {},
            isLoading: false,
            isLoaded: true,
          });
        } catch {
          set({ installed: false, categories: {}, agents: {}, isLoading: false, isLoaded: true });
        }
      },
    }),
    {
      name: "oh-my-opencode-store",
    },
  ),
);
