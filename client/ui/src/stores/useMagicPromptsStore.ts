import { create } from 'zustand';

type MagicPromptsState = {
  selectedPromptId: string;
  setSelectedPromptId: (id: string) => void;
};

const DEFAULT_PROMPT_ID = 'git.commit.generate';

export const useMagicPromptsStore = create<MagicPromptsState>((set) => ({
  selectedPromptId: DEFAULT_PROMPT_ID,
  setSelectedPromptId: (id) => {
    set((state) => {
      if (state.selectedPromptId === id) {
        return state;
      }
      return { selectedPromptId: id };
    });
  },
}));
