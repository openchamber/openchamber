import React from 'react';
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import { Icon } from '@/components/icon/Icon';
import type { MessageListHandle } from './MessageList';

interface ChatSearchWidgetProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageListRef: React.RefObject<MessageListHandle | null>;
}

export const ChatSearchWidget: React.FC<ChatSearchWidgetProps> = ({
  scrollRef,
  messageListRef,
}) => {
  const isOpen = useChatSearchStore((s) => s.isOpen);
  const query = useChatSearchStore((s) => s.query);
  const flags = useChatSearchStore((s) => s.flags);
  const scope = useChatSearchStore((s) => s.scope);
  const activeIndex = useChatSearchStore((s) => s.activeIndex);
  const totalMatches = useChatSearchStore((s) => s.totalMatches);

  const inputRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus input when widget opens.
  React.useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Single helper that clears all .active marks, applies .active to `index`,
  // and scrolls it into view. Used by both the recount and navigation effects.
  const applyActiveMark = React.useCallback(
    (index: number) => {
      const container = scrollRef.current;
      if (!container) return;
      const marks = Array.from(
        container.querySelectorAll<HTMLElement>('mark[data-search-match]'),
      );
      marks.forEach((m) => m.classList.remove('active'));
      if (marks.length === 0) return;
      const clamped = Math.max(0, Math.min(index, marks.length - 1));
      const target = marks[clamped];
      target.classList.add('active');
      const messageAncestor = target.closest<HTMLElement>('[data-message-id]');
      const messageId = messageAncestor?.dataset.messageId;
      if (messageId && messageListRef.current) {
        messageListRef.current.scrollToMessageId(messageId, { behavior: 'smooth' });
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      } else {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },
    [scrollRef, messageListRef],
  );

  // Recount marks and activate first match when query/flags/scope change.
  // Debounced 350ms to let React re-render text components with new marks first.
  React.useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;
      const marks = Array.from(
        container.querySelectorAll<HTMLElement>('mark[data-search-match]'),
      );
      useChatSearchStore.getState().setTotalMatches(marks.length);
      useChatSearchStore.getState().setActiveIndex(0);
      // Always apply directly here — setActiveIndex(0) does not fire the
      // navigation effect below when activeIndex was already 0.
      applyActiveMark(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, flags.caseSensitive, flags.wholeWord, flags.regex, scope, isOpen, scrollRef, applyActiveMark]);

  // Activate correct mark when user navigates (prev / next).
  React.useEffect(() => {
    if (!isOpen) return;
    applyActiveMark(activeIndex);
  }, [activeIndex, isOpen, applyActiveMark]);

  // Clean up .active marks when widget closes.
  React.useEffect(() => {
    if (!isOpen) {
      const container = scrollRef.current;
      if (!container) return;
      container
        .querySelectorAll<HTMLElement>('mark[data-search-match].active')
        .forEach((el) => el.classList.remove('active'));
    }
  }, [isOpen, scrollRef]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // prevent global double-ESC abort handler
      useChatSearchStore.getState().close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      useChatSearchStore.getState().navigate(e.shiftKey ? 'prev' : 'next');
    }
  };

  const flagButtonClass = (active: boolean) =>
    [
      'h-6 px-1.5 rounded text-xs font-mono border transition-colors cursor-pointer select-none',
      active
        ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)] border-[var(--interactive-selection)]'
        : 'bg-transparent text-[var(--surface-mutedForeground)] border-[var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
    ].join(' ');

  const countLabel =
    totalMatches === 0
      ? query
        ? 'No results'
        : ''
      : `${activeIndex + 1} of ${totalMatches}`;

  return (
    <div
      className="absolute top-2 right-3 z-50 flex items-center gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 shadow-lg"
      style={{ minWidth: 284 }}
    >
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => useChatSearchStore.getState().setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat"
        className="h-6 flex-1 min-w-0 bg-transparent text-xs text-[var(--surface-foreground)] placeholder:text-[var(--surface-mutedForeground)] outline-none"
        style={
          totalMatches === 0 && query
            ? { color: 'var(--status-error)' }
            : undefined
        }
        aria-label="Search chat"
      />

      {/* Flag toggles */}
      <button
        type="button"
        title="Case sensitive"
        className={flagButtonClass(flags.caseSensitive)}
        onClick={() => useChatSearchStore.getState().setFlag('caseSensitive', !flags.caseSensitive)}
        aria-pressed={flags.caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        title="Whole word"
        className={flagButtonClass(flags.wholeWord)}
        onClick={() => useChatSearchStore.getState().setFlag('wholeWord', !flags.wholeWord)}
        aria-pressed={flags.wholeWord}
        style={{ textDecoration: 'underline' }}
      >
        ab
      </button>
      <button
        type="button"
        title="Use regular expression"
        className={flagButtonClass(flags.regex)}
        onClick={() => useChatSearchStore.getState().setFlag('regex', !flags.regex)}
        aria-pressed={flags.regex}
      >
        .*
      </button>

      {/* Scope toggle */}
      <button
        type="button"
        title={
          scope === 'text'
            ? 'Searching user + assistant text. Click to search all content including tool outputs.'
            : 'Searching all content. Click to search text only.'
        }
        className={flagButtonClass(scope === 'all')}
        onClick={() => useChatSearchStore.getState().toggleScope()}
        aria-pressed={scope === 'all'}
      >
        {scope === 'text' ? 'T' : 'All'}
      </button>

      {/* Divider */}
      <span className="h-4 w-px bg-[var(--interactive-border)] mx-0.5" aria-hidden />

      {/* Match count */}
      <span
        className="text-xs tabular-nums min-w-[52px] text-center text-[var(--surface-mutedForeground)] shrink-0"
        aria-live="polite"
      >
        {countLabel}
      </span>

      {/* Prev / Next */}
      <button
        type="button"
        title="Previous match (Shift+Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)] disabled:opacity-40"
        onClick={() => useChatSearchStore.getState().navigate('prev')}
        disabled={totalMatches === 0}
        aria-label="Previous match"
      >
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)] disabled:opacity-40"
        onClick={() => useChatSearchStore.getState().navigate('next')}
        disabled={totalMatches === 0}
        aria-label="Next match"
      >
        <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
      </button>

      {/* Close */}
      <button
        type="button"
        title="Close (Escape)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)]"
        onClick={() => useChatSearchStore.getState().close()}
        aria-label="Close search"
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export default ChatSearchWidget;
