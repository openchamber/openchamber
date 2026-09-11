import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findMatchRanges } from './markdownPreviewFind';

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
 * The rendered DOM is owned by the markdown renderer (block-level morphdom
 * reconciliation), so highlights are re-applied whenever the renderer mutates
 * the container (theme or content changes) via a MutationObserver; mutations
 * produced by this widget itself are ignored.
 */
const MARK_ATTR = 'data-md-find';
const CURRENT_MARK_ATTR = 'data-md-find-current';
const MARK_CLASS = 'rounded-[2px] bg-status-warning/30 text-foreground';
const CURRENT_MARK_CLASS = 'rounded-[2px] bg-status-warning/60 text-foreground';
/** Keystrokes re-walk the whole preview, so coalesce bursts of typing. */
const SEARCH_DEBOUNCE_MS = 120;

const isMarkElement = (node: Node): boolean => {
  return node instanceof Element && node.hasAttribute(MARK_ATTR);
};

/** True when this widget's own highlight surgery produced the record. */
const isSelfProducedMutation = (record: MutationRecord): boolean => {
  if (record.target instanceof Element && record.target.hasAttribute(MARK_ATTR)) {
    return true;
  }
  return [...record.addedNodes].some((node) => isMarkElement(node));
};

const clearHighlights = (container: HTMLElement): void => {
  const touchedParents = new Set<Node>();
  container.querySelectorAll(`mark[${MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    touchedParents.add(parent);
  });
  // Once per affected parent instead of once per mark. Merging the split text
  // nodes back together is safe under the renderer's morphdom path: it diffs
  // against a tree freshly parsed from HTML, where the merged single text node
  // is exactly the shape it expects.
  touchedParents.forEach((parent) => parent.normalize());
};

const applySearch = (container: HTMLElement, query: string): HTMLElement[] => {
  clearHighlights(container);

  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const marks: HTMLElement[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skipping svg (mermaid) keeps the highlight pass from corrupting
      // diagram rendering; script/style content is never visible anyway.
      if (parent.closest('svg, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text) {
      textNodes.push(node);
    }
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    if (!text) {
      continue;
    }
    const ranges = findMatchRanges(text, normalized);
    if (ranges.length === 0) {
      continue;
    }

    const parent = node.parentNode;
    if (!parent) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
      }
      const mark = document.createElement('mark');
      mark.setAttribute(MARK_ATTR, '');
      mark.className = MARK_CLASS;
      mark.textContent = text.slice(range.start, range.end);
      fragment.appendChild(mark);
      marks.push(mark);
      cursor = range.end;
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(fragment, node);
  }

  return marks;
};

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
  const marksRef = React.useRef<HTMLElement[]>([]);
  const queryRef = React.useRef(query);
  queryRef.current = query;
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus returns here when the bar closes, so Escape does not strand focus.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  /**
   * `keepIndex` distinguishes a new query (start at match 1) from a re-search
   * of the same query after the renderer re-morphed the container: a theme
   * toggle or content refresh must not yank the reader back to match 1.
   */
  const runSearch = React.useCallback((nextQuery: string, keepIndex = false) => {
    const container = containerRef.current;
    if (!container) {
      marksRef.current = [];
      setTotal(0);
      setIndex(0);
      return;
    }
    marksRef.current = applySearch(container, nextQuery);
    const nextTotal = marksRef.current.length;
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

  // Re-apply highlights when the renderer re-morphs the container (theme or
  // content changes), ignoring mutations this widget produces itself. Only
  // active while the bar is open; closing clears the highlights.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) {
      return;
    }
    const observer = new MutationObserver((records) => {
      if (!queryRef.current.trim()) {
        return;
      }
      // Per record, not per batch: the renderer can deliver a genuine mutation
      // in the same batch as one of ours, and `.some` would swallow it.
      const rendererTouched = records.some((record) => !isSelfProducedMutation(record));
      if (!rendererTouched) {
        return;
      }
      // Debounced like typing — a morph batch would otherwise pay a full
      // TreeWalker plus DOM surgery per mutation batch.
      scheduleSearch(queryRef.current, true);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearHighlights(container);
    };
  }, [containerRef, open, scheduleSearch]);

  // Focus the input when the bar opens, remembering what to restore on close.
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement;
    if (previous instanceof HTMLElement && !returnFocusRef.current) {
      returnFocusRef.current = previous;
    }
    inputRef.current?.focus();
  }, [open]);

  // Pressing the find shortcut again re-focuses and re-selects the query.
  React.useEffect(() => {
    if (open && focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, focusNonce]);

  // Keep the current-match highlight and scroll it into view.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.querySelectorAll(`mark[${CURRENT_MARK_ATTR}]`).forEach((mark) => {
      mark.removeAttribute(CURRENT_MARK_ATTR);
      mark.className = MARK_CLASS;
    });
    if (total === 0) {
      return;
    }
    const current = marksRef.current[Math.min(Math.max(index, 0), total - 1)];
    if (!current) {
      return;
    }
    current.setAttribute(CURRENT_MARK_ATTR, '');
    current.className = CURRENT_MARK_CLASS;
    current.scrollIntoView({ block: 'nearest' });
  }, [containerRef, index, total]);

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
    <div className={cn('absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-1.5 py-1 shadow-lg', className)}>
      <Icon name="search" className="ml-0.5 size-3.5 text-muted-foreground" />
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
