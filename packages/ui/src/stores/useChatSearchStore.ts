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
  /** Message ID for annotating <mark> elements with data-search-msg. */
  messageId: string;
}

/**
 * One entry per match found in the message data layer.
 * `messageId` is used to scroll the virtualised list to the right message
 * before the widget activates the corresponding DOM <mark> element.
 */
export interface MatchRecord {
  messageId: string;
  occurrenceInMessage: number; // 0-based index within the message
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
  /**
   * True while older message pages are being fetched from the server so the
   * search can cover the full history. Set by ChatContainer's pagination loop.
   */
  isLoadingForSearch: boolean;
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
   * `preserveMessageId`: if provided and still present in the new list, keeps
   * activeIndex pointing at the first match in that message instead of
   * resetting to 0. Pass null when query/flags changed (always reset).
   */
  setMatches: (matches: MatchRecord[], preserveMessageId: string | null) => void;
  setIsLoadingForSearch: (loading: boolean) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  isOpen: false,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  matches: [],
  totalMatches: 0,
  activeIndex: 0,
  isLoadingForSearch: false,

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
  setMatches: (newMatches, preserveMessageId) => {
    if (preserveMessageId !== null) {
      const restoredIndex = newMatches.findIndex(
        (m) => m.messageId === preserveMessageId,
      );
      if (restoredIndex !== -1) {
        set({ matches: newMatches, totalMatches: newMatches.length, activeIndex: restoredIndex });
        return;
      }
    }
    set({ matches: newMatches, totalMatches: newMatches.length, activeIndex: 0 });
  },
  setIsLoadingForSearch: (loading) => set({ isLoadingForSearch: loading }),
}));
