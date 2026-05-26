import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useChatSearchStore } from '@/stores/useChatSearchStore';

const panelStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)',
  boxShadow: '0 2px 8px color-mix(in srgb, var(--surface-background) 60%, transparent)',
  width: 'min(400px, calc(100% - 28px))',
};

const inputBaseClass = [
  'h-[26px] m-0 px-2 rounded-[6px]',
  'border border-[var(--interactive-border)]',
  'bg-[var(--surface-background)]',
  'text-[12px] leading-none text-[var(--surface-foreground)]',
  'placeholder:text-[var(--surface-muted-foreground)]',
  'outline-none transition-colors duration-150',
  'focus:border-[var(--primary-base)]',
].join(' ');

const toggleButtonClass = (active: boolean) => [
  'inline-flex items-center justify-center',
  'w-[26px] h-[26px] min-w-[26px] shrink-0 ml-px p-0',
  'rounded border text-[13px] font-semibold leading-none',
  'transition-colors duration-100 cursor-pointer select-none',
  active
    ? 'bg-[var(--interactive-hover)] border-[var(--interactive-border)] text-[var(--surface-foreground)]'
    : 'bg-transparent border-transparent text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
].join(' ');

const actionButtonClass = (disabled?: boolean) => [
  'inline-flex items-center justify-center',
  'w-[26px] h-[26px] min-w-[26px] shrink-0 ml-px p-0',
  'rounded border-none bg-transparent',
  'text-[var(--surface-muted-foreground)]',
  'text-[15px] leading-none',
  'transition-colors duration-100 cursor-pointer',
  'hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
  'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--interactive-focus-ring)]',
  disabled ? 'opacity-40 cursor-default pointer-events-none' : '',
].join(' ');

interface ChatSearchWidgetProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Scroll to and reveal the target message, expanding the turn window if the
   * message is hidden behind the "Load older messages" boundary.
   * Provided by timelineController.scrollToMessage.
   */
  scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
}

export const ChatSearchWidget: React.FC<ChatSearchWidgetProps> = ({
  scrollRef,
  scrollToMessage,
}) => {
  const { t } = useI18n();
  const isOpen = useChatSearchStore((s) => s.isOpen);
  const query = useChatSearchStore((s) => s.query);
  const flags = useChatSearchStore((s) => s.flags);
  const activeIndex = useChatSearchStore((s) => s.activeIndex);
  const matches = useChatSearchStore((s) => s.matches);
  const totalMatches = useChatSearchStore((s) => s.totalMatches);
  const isLoadingForSearch = useChatSearchStore((s) => s.isLoadingForSearch);

  const inputRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus input when widget opens.
  React.useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  /**
   * Data-driven navigation:
   *
   * 1. Look up which message contains the active match from the data layer.
   * 2. Call scrollToMessage (timelineController) which expands the turn window
   *    if the message is hidden behind "Load older messages", then scrolls the
   *    virtualised list to bring the message into view.
   * 3. Retry (up to 16 rAFs) until the <mark> elements for that message are
   *    painted, then activate marks[activeIndex].
   *
   * Extra retries (vs 8 before) cover the extra render cycles from turn-window
   * expansion: state update → re-render → layout effect → virtualiser render.
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

    let cancelled = false;

    const run = async () => {
      // Expand turn window (if needed) and scroll to the target message.
      await scrollToMessage(match.messageId, { behavior: 'smooth' });

      if (cancelled) return;

      // Retry until the <mark> is painted. Window expansion adds extra render
      // cycles, so we allow up to 16 frames instead of 8.
      const activate = (attempt: number) => {
        if (cancelled) return;

        // Clear all active marks first
        container
          .querySelectorAll<HTMLElement>('mark[data-search-match].active')
          .forEach((el) => el.classList.remove('active'));

        // Find marks belonging specifically to this message using data-search-msg.
        // This is robust against earlier messages being virtualized out of the DOM —
        // we no longer rely on a global mark index.
        const messageMarks = Array.from(
          container.querySelectorAll<HTMLElement>(
            `mark[data-search-match][data-search-msg="${CSS.escape(match.messageId)}"]`,
          ),
        );

        const target = messageMarks[match.occurrenceInMessage];
        if (target) {
          target.classList.add('active');
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (attempt < 16) {
          requestAnimationFrame(() => activate(attempt + 1));
        }
      };

      requestAnimationFrame(() => activate(0));
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [activeIndex, isOpen, matches, scrollRef, scrollToMessage]);

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

  const countLabel = isLoadingForSearch
    ? t('chat.search.loading')
    : totalMatches > 0
      ? `${activeIndex + 1}/${totalMatches}`
      : t('chat.search.noResults');

  // ── Icon-only toggle button (matches CodeMirror search panel style) ──
  const ToggleButton: React.FC<{
    active: boolean;
    onClick: () => void;
    title: string;
    icon: React.ReactNode;
    ariaLabel: string;
  }> = ({ active, onClick, title, icon, ariaLabel }) => (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={toggleButtonClass(active)}
    >
      {icon}
    </button>
  );

  // ── Icon-only action button (arrows, close) ──
  const ActionButton: React.FC<{
    onClick: () => void;
    title: string;
    ariaLabel: string;
    disabled?: boolean;
    children: React.ReactNode;
  }> = ({ onClick, title, ariaLabel, disabled, children }) => (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={actionButtonClass(disabled)}
    >
      {children}
    </button>
  );

  return (
    <div
      className="absolute top-[6px] right-[14px] z-50 pointer-events-auto rounded-[10px] border border-[var(--interactive-border)] p-1 text-[13px] leading-none text-[var(--surface-foreground)]"
      style={panelStyle}
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
      {/* ── Single row that wraps to two rows when the panel is narrowed ──
           Row 1: [Find input (grows)]
           Row 2 (when narrow): [Aa] [.*] [ab] [count] [↑] [↓] [×]   ── */}
      <div className="flex w-full flex-wrap items-center gap-y-1 [font-family:inherit] text-[13px] leading-none text-[var(--surface-foreground)]">
        {/* Find input — expands to fill all available width */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => useChatSearchStore.getState().setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.search.findPlaceholder')}
          className={`${inputBaseClass} min-w-[160px] flex-[1_1_160px]`}
          aria-label={t('chat.search.findAria')}
        />

        {/* Controls — kept as one non-wrapping group so they either share
            row 1 with the input or drop cleanly together to row 2 */}
        <div className="ml-auto flex shrink-0 items-center">
          {/* Toggle buttons */}
          <ToggleButton
            active={flags.caseSensitive}
            onClick={() => useChatSearchStore.getState().setFlag('caseSensitive', !flags.caseSensitive)}
            title={t('chat.search.matchCase')}
            ariaLabel={t('chat.search.matchCase')}
            icon="Aa"
          />
          <ToggleButton
            active={flags.regex}
            onClick={() => useChatSearchStore.getState().setFlag('regex', !flags.regex)}
            title={t('chat.search.useRegex')}
            ariaLabel={t('chat.search.useRegex')}
            icon=".*"
          />
          <ToggleButton
            active={flags.wholeWord}
            onClick={() => useChatSearchStore.getState().setFlag('wholeWord', !flags.wholeWord)}
            title={t('chat.search.matchWholeWord')}
            ariaLabel={t('chat.search.matchWholeWord')}
            icon={<span className="underline decoration-current underline-offset-2">ab</span>}
          />

          {/* Match count — fixed width keeps layout stable between "No results" and "1/3" */}
          <span
            className="inline-flex w-[56px] shrink-0 items-center justify-center whitespace-nowrap bg-transparent text-[11px] leading-[26px] text-[var(--surface-muted-foreground)] tabular-nums"
            aria-live="polite"
            aria-atomic="true"
          >
            {countLabel}
          </span>

          {/* Navigation */}
          <ActionButton
            onClick={() => useChatSearchStore.getState().navigate('prev')}
            title={t('chat.search.previous')}
            ariaLabel={t('chat.search.previousAria')}
            disabled={totalMatches === 0}
          >
            ↑
          </ActionButton>
          <ActionButton
            onClick={() => useChatSearchStore.getState().navigate('next')}
            title={t('chat.search.next')}
            ariaLabel={t('chat.search.nextAria')}
            disabled={totalMatches === 0}
          >
            ↓
          </ActionButton>

          {/* Close */}
          <button
            type="button"
            title={t('chat.search.close')}
            aria-label={t('chat.search.closeAria')}
            onClick={() => useChatSearchStore.getState().close()}
            className="ml-px inline-flex h-[26px] w-[26px] min-w-[26px] shrink-0 items-center justify-center overflow-visible rounded border-none bg-transparent p-0 text-[16px] leading-none text-[var(--surface-muted-foreground)] transition-colors duration-100 hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatSearchWidget;
