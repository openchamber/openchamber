import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
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
const MARK_CLASS = 'rounded-[2px] bg-[var(--status-warning)]/40';
const CURRENT_MARK_CLASS = 'rounded-[2px] bg-[var(--status-warning)]/80';

const isMarkElement = (node: Node): boolean => {
  return node instanceof Element && node.hasAttribute(MARK_ATTR);
};

const clearHighlights = (container: HTMLElement): void => {
  container.querySelectorAll(`mark[${MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  });
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
    textNodes.push(walker.currentNode as Text);
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
};

export const MarkdownPreviewSearch: React.FC<MarkdownPreviewSearchProps> = ({
  containerRef,
  open,
  onOpenChange,
  focusNonce,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [total, setTotal] = React.useState(0);
  const [index, setIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const marksRef = React.useRef<HTMLElement[]>([]);
  const queryRef = React.useRef(query);
  queryRef.current = query;

  const runSearch = React.useCallback((nextQuery: string) => {
    const container = containerRef.current;
    if (!container) {
      marksRef.current = [];
      setTotal(0);
      setIndex(0);
      return;
    }
    marksRef.current = applySearch(container, nextQuery);
    setTotal(marksRef.current.length);
    setIndex(0);
  }, [containerRef]);

  // Re-apply highlights when the renderer re-morphs the container (theme or
  // content changes), ignoring mutations this widget produces itself. Only
  // active while the bar is open; closing clears the highlights.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) {
      return;
    }
    const observer = new MutationObserver((records) => {
      const fromUs = records.some((record) => {
        if (record.target instanceof Element && record.target.hasAttribute(MARK_ATTR)) {
          return true;
        }
        return [...record.addedNodes].some((node) => isMarkElement(node));
      });
      if (fromUs) {
        return;
      }
      runSearch(queryRef.current);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearHighlights(container);
    };
  }, [containerRef, open, runSearch]);

  // Focus the input when the bar opens.
  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
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
      onOpenChange(false);
    }
  }, [goToNext, goToPrevious, onOpenChange]);

  if (!open) {
    return null;
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-1.5 py-1 shadow-lg">
      <Icon name="search" className="ml-0.5 size-3.5 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          runSearch(event.target.value);
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
          : undefined}
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
        onClick={() => onOpenChange(false)}
        title={t('filesView.preview.find.closeAria')}
        aria-label={t('filesView.preview.find.closeAria')}
      >
        <Icon name="close" className="size-3.5" />
      </Button>
    </div>
  );
};
