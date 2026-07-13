import { create } from 'zustand';

export interface SearchFlags {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** When true, reasoning/thinking parts are included in search and highlighting. Defaults to false. */
  includeThinking?: boolean;
}

export interface SearchContext {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  /** Message ID for annotating <mark> elements with data-search-msg. */
  messageId: string;
  /** Part identity keeps matches distinct when one message has many parts. */
  partId?: string;
  partType?: 'text' | 'reasoning';
}

/**
 * One entry per logical match found in one message part. A cross-inline
 * boundary match may produce multiple DOM fragments, all sharing this
 * part-local occurrence identity.
 */
export interface MatchRecord {
  messageId: string;
  partId: string;
  partType: 'text' | 'reasoning';
  occurrenceInPart: number; // 0-based index within the part
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
   * `preserveMatch`: if provided and still present in the new list, keeps
   * activeIndex on the same logical part occurrence instead of resetting to 0.
   * Pass null when query/flags changed (always reset).
   */
  setMatches: (matches: MatchRecord[], preserveMatch: MatchRecord | null) => void;
  setIsLoadingForSearch: (loading: boolean) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  isOpen: false,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false, includeThinking: false },
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
  setMatches: (newMatches, preserveMatch) => {
    if (preserveMatch !== null) {
      const restoredIndex = newMatches.findIndex(
        (m) => m.messageId === preserveMatch.messageId
          && m.partId === preserveMatch.partId
          && m.partType === preserveMatch.partType
          && m.occurrenceInPart === preserveMatch.occurrenceInPart,
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
