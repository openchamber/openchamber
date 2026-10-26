import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findPreviewRanges, scrollPreviewRangeIntoView } from './markdownPreviewFind';

/**
 * In-preview text search for the rendered Markdown file preview.
 *
 * The preview renders as plain DOM (no iframe/shadow root), so browser-native
 * find works on web — but the Electron desktop shell has no find-in-page
 * implementation at all, and CodeMirror's search only exists in edit mode.
 * This widget provides the find shortcut behavior (Ctrl/Cmd+F) and a compact
 * search bar with match highlighting, navigation, and a live count, scoped to
 * the preview container.
 *
 * React owns the rendered text. Search paints DOM Ranges without changing it,
 * and rebuilds the ranges after renderer content updates.
 */
/** Keystrokes re-walk the whole preview, so coalesce bursts of typing. */
const SEARCH_DEBOUNCE_MS = 120;

type MarkdownPreviewSearchProps = {
  /** The scrollable preview container whose rendered text is searched. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped every time the find shortcut is pressed to re-focus the input. */
  focusNonce: number;
  /** Layout overrides for the floating bar (position, offsets). */
  className?: string;
};

export const MarkdownPreviewSearch: React.FC<MarkdownPreviewSearchProps> = ({
  containerRef,
  open,
  onOpenChange,
  focusNonce,
  className,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [total, setTotal] = React.useState(0);
  const [index, setIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [ranges, setRanges] = React.useState<Range[]>([]);
  const highlightId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const highlightName = `oc-preview-search-${highlightId}`;
  const currentHighlightName = `${highlightName}-current`;
  const queryRef = React.useRef(query);
  queryRef.current = query;
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus returns here when the bar closes, so Escape does not strand focus.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  /**
   * `keepIndex` distinguishes a new query (start at match 1) from a re-search
   * of the same query after the renderer updated the container: a theme
   * toggle or content refresh must not yank the reader back to match 1.
   */
  const runSearch = React.useCallback((nextQuery: string, keepIndex = false) => {
    const container = containerRef.current;
    if (!container) {
      setRanges([]);
      setTotal(0);
      setIndex(0);
      return;
    }
    const nextRanges = findPreviewRanges(container, nextQuery);
    setRanges(nextRanges);
    const nextTotal = nextRanges.length;
    setTotal(nextTotal);
    setIndex((current) => {
      if (!keepIndex || nextTotal === 0) {
        return 0;
      }
      return Math.min(current, nextTotal - 1);
    });
  }, [containerRef]);

  const scheduleSearch = React.useCallback((nextQuery: string, keepIndex = false) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      runSearch(nextQuery, keepIndex);
    }, SEARCH_DEBOUNCE_MS);
  }, [runSearch]);

  React.useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, []);

  const close = React.useCallback(() => {
    onOpenChange(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, [onOpenChange]);

  // Only content mutations trigger a scan. Painting highlights emits none.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) {
      return;
    }
    runSearch(queryRef.current, true);
    const observer = new MutationObserver(() => {
      if (!queryRef.current.trim()) {
        return;
      }
      // Drop ranges immediately so removed text is never kept highlighted
      // during the debounced content refresh.
      setRanges([]);
      scheduleSearch(queryRef.current, true);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [containerRef, open, runSearch, scheduleSearch]);

  // Focus the input when the bar opens, remembering what to restore on close.
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const previous = containerRef.current?.ownerDocument.activeElement;
    if (previous instanceof HTMLElement && !returnFocusRef.current) {
      returnFocusRef.current = previous;
    }
    inputRef.current?.focus();
  }, [containerRef, open]);

  // Pressing the find shortcut again re-focuses and re-selects the query.
  React.useEffect(() => {
    if (open && focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, focusNonce]);

  // Each mounted preview owns its registry names and their stylesheet.
  React.useEffect(() => {
    const container = containerRef.current;
    const view = container?.ownerDocument.defaultView;
    // Unsupported browsers still get counts and navigation, without painting.
    if (!open || !container || !view || !('Highlight' in view) || !('highlights' in view.CSS)) return;
    const registry = view.CSS.highlights;
    const style = container.ownerDocument.createElement('style');
    style.textContent = `::highlight(${highlightName}) { background-color: color-mix(in srgb, var(--status-warning) 30%, transparent); color: var(--surface-foreground); }
::highlight(${currentHighlightName}) { background-color: color-mix(in srgb, var(--status-warning) 60%, transparent); color: var(--surface-foreground); }`;
    container.ownerDocument.head.append(style);
    if (ranges.length > 0) {
      const all = new view.Highlight();
      for (const range of ranges) all.add(range);
      registry.set(highlightName, all);
      const current = new view.Highlight(ranges[Math.min(index, ranges.length - 1)]);
      current.priority = 1;
      registry.set(currentHighlightName, current);
    }
    return () => {
      registry.delete(highlightName);
      registry.delete(currentHighlightName);
      style.remove();
    };
  }, [containerRef, currentHighlightName, highlightName, index, open, ranges]);

  React.useEffect(() => {
    const container = containerRef.current;
    const current = ranges[index];
    if (open && container && current) scrollPreviewRangeIntoView(container, current);
  }, [containerRef, index, open, ranges]);

  const goToNext = React.useCallback(() => {
    setIndex((current) => (total === 0 ? 0 : (current + 1) % total));
  }, [total]);

  const goToPrevious = React.useCallback(() => {
    setIndex((current) => (total === 0 ? 0 : (current - 1 + total) % total));
  }, [total]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        goToPrevious();
      } else {
        goToNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }, [close, goToNext, goToPrevious]);

  if (!open) {
    return null;
  }

  return (
    <div className={cn('absolute inset-e-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-1.5 py-1 shadow-lg', className)}>
      <Icon name="search" className="ms-0.5 size-3.5 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          scheduleSearch(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder={t('filesView.preview.find.placeholder')}
        aria-label={t('filesView.preview.find.placeholder')}
        className="h-7 w-40 rounded-md px-2 py-0 text-sm md:w-56"
      />
      <span
        className="min-w-12 px-1 text-center typography-micro text-muted-foreground tabular-nums"
        aria-live="polite"
        aria-label={total > 0
          ? t('filesView.preview.find.countAria', { current: index + 1, total })
          : t('filesView.preview.find.noMatches')}
      >
        {query.trim() && total === 0
          ? t('filesView.preview.find.noMatches')
          : total > 0
            ? `${index + 1}/${total}`
            : ''}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={goToPrevious}
        title={t('filesView.preview.find.previousAria')}
        aria-label={t('filesView.preview.find.previousAria')}
        disabled={total === 0}
      >
        <Icon name="arrow-up" className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={goToNext}
        title={t('filesView.preview.find.nextAria')}
        aria-label={t('filesView.preview.find.nextAria')}
        disabled={total === 0}
      >
        <Icon name="arrow-down" className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={close}
        title={t('filesView.preview.find.closeAria')}
        aria-label={t('filesView.preview.find.closeAria')}
      >
        <Icon name="close" className="size-3.5" />
      </Button>
    </div>
  );
};
