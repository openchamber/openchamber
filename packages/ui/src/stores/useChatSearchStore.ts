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

/**
 * One entry per match found in the message data layer.
 * `messageId` is used to scroll the virtualised list to the right message
 * before the widget activates the corresponding DOM <mark> element.
 */
export interface MatchRecord {
  messageId: string;
}

interface ChatSearchState {
  isOpen: boolean;
  query: string;
  flags: SearchFlags;
  /** Ordered list of all matches from the data layer. Length = totalMatches. */
  matches: MatchRecord[];
  /** Derived from matches.length; kept as a field so selectors stay cheap. */
  totalMatches: number;
  activeIndex: number;
  open: () => void;
  // close preserves query/flags so reopening restores the previous search
  close: () => void;
  setQuery: (q: string) => void;
  setFlag: (flag: keyof SearchFlags, value: boolean) => void;
  // navigate wraps around: 'next' on the last match goes to index 0, 'prev' on index 0 goes to last
  navigate: (dir: 'prev' | 'next') => void;
  setActiveIndex: (n: number) => void;
  /**
   * Called by useChatSearchMatcher with the freshly computed match list.
   * Also resets activeIndex to 0 so navigation starts from the top.
   */
  setMatches: (matches: MatchRecord[]) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  isOpen: false,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  matches: [],
  totalMatches: 0,
  activeIndex: 0,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setQuery: (q) => set({ query: q }),
  setFlag: (flag, value) =>
    set((state) => ({ flags: { ...state.flags, [flag]: value } })),
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
  setMatches: (newMatches) =>
    set({ matches: newMatches, totalMatches: newMatches.length, activeIndex: 0 }),
}));
