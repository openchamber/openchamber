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
  const activeIndex = useChatSearchStore((s) => s.activeIndex);
  const matches = useChatSearchStore((s) => s.matches);
  const totalMatches = useChatSearchStore((s) => s.totalMatches);

  const inputRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus input when widget opens.
  React.useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  /**
   * Data-driven navigation (CR-001 fix):
   *
   * 1. Look up which message contains the active match from the data layer.
   * 2. Scroll the virtualised list to bring that message into the viewport.
   * 3. Retry (up to 8 rAFs) until the <mark> elements for that message are
   *    painted, then activate marks[activeIndex].
   *
   * This works because the data-layer match order is the same as DOM mark
   * order (both iterate messages/parts in document order), so the Nth data
   * match corresponds to the Nth <mark data-search-match> in the scroll container.
   */
  React.useEffect(() => {
    if (!isOpen || matches.length === 0) {
      // Clear any leftover active mark when search closes or produces no results.
      const container = scrollRef.current;
      if (container) {
        container
          .querySelectorAll<HTMLElement>('mark[data-search-match].active')
          .forEach((el) => el.classList.remove('active'));
      }
      return;
    }

    const match = matches[activeIndex];
    if (!match) return;

    const container = scrollRef.current;
    if (!container) return;

    // Scroll the virtualised list to ensure the target message is rendered.
    if (messageListRef.current) {
      messageListRef.current.scrollToMessageId(match.messageId, { behavior: 'smooth' });
    }

    // Retry until the mark is painted (virtualised messages need 1-3 frames).
    const activate = (attempt: number) => {
      const allMarks = Array.from(
        container.querySelectorAll<HTMLElement>('mark[data-search-match]'),
      );
      // Clear previous active.
      allMarks.forEach((m) => m.classList.remove('active'));

      const target = allMarks[activeIndex];
      if (target) {
        target.classList.add('active');
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (attempt < 8) {
        // Message not yet rendered; wait another frame.
        requestAnimationFrame(() => activate(attempt + 1));
      }
    };

    requestAnimationFrame(() => activate(0));
  }, [activeIndex, isOpen, matches, scrollRef, messageListRef]);

  // Clean up active marks when the widget closes.
  React.useEffect(() => {
    if (!isOpen) {
      scrollRef.current
        ?.querySelectorAll<HTMLElement>('mark[data-search-match].active')
        .forEach((el) => el.classList.remove('active'));
    }
  }, [isOpen, scrollRef]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape is handled by the widget root div's onKeyDown to cover all focused elements.
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
      // Capture Escape from any focused element inside the widget and stop
      // propagation so the global double-ESC abort handler is never reached.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          useChatSearchStore.getState().close();
        }
      }}
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
        aria-label="Search chat messages"
      />

      {/* Flag toggles */}
      <button
        type="button"
        title="Match case"
        aria-label="Match case"
        className={flagButtonClass(flags.caseSensitive)}
        onClick={() => useChatSearchStore.getState().setFlag('caseSensitive', !flags.caseSensitive)}
        aria-pressed={flags.caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        title="Match whole word"
        aria-label="Match whole word"
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
        aria-label="Use regular expression"
        className={flagButtonClass(flags.regex)}
        onClick={() => useChatSearchStore.getState().setFlag('regex', !flags.regex)}
        aria-pressed={flags.regex}
      >
        .*
      </button>

      {/* Divider */}
      <span className="h-4 w-px bg-[var(--interactive-border)] mx-0.5" aria-hidden />

      {/* Match count */}
      <span
        className="text-xs tabular-nums min-w-[52px] text-center text-[var(--surface-mutedForeground)] shrink-0"
        aria-live="polite"
        aria-atomic="true"
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
