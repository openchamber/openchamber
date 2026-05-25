import { create } from 'zustand';

export interface SearchFlags {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchContext {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

interface ChatSearchState {
  isOpen: boolean;
  query: string;
  flags: SearchFlags;
  scope: 'text' | 'all';
  activeIndex: number;
  totalMatches: number;
  open: () => void;
  // close preserves query/flags so reopening restores the previous search
  close: () => void;
  setQuery: (q: string) => void;
  setFlag: (flag: keyof SearchFlags, value: boolean) => void;
  toggleScope: () => void;
  // navigate wraps around: 'next' on the last match goes to index 0, 'prev' on index 0 goes to last
  navigate: (dir: 'prev' | 'next') => void;
  setActiveIndex: (n: number) => void;
  setTotalMatches: (n: number) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  isOpen: false,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  scope: 'text',
  activeIndex: 0,
  totalMatches: 0,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setQuery: (q) => set({ query: q }),
  setFlag: (flag, value) =>
    set((state) => ({ flags: { ...state.flags, [flag]: value } })),
  toggleScope: () =>
    set((state) => ({ scope: state.scope === 'text' ? 'all' : 'text' })),
  navigate: (dir) => {
    const { activeIndex, totalMatches } = get();
    if (totalMatches === 0) return;
    const next =
      dir === 'next'
        ? (activeIndex + 1) % totalMatches
        : (activeIndex - 1 + totalMatches) % totalMatches;
    set({ activeIndex: next });
  },
  setActiveIndex: (n) => set({ activeIndex: n }),
  setTotalMatches: (n) => set({ totalMatches: n }),
}));
