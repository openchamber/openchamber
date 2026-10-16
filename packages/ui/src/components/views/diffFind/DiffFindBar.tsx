import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type DiffFindBarProps = {
  /** The current search text. The bar is controlled; the parent owns the state. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Number of matches found so far across the changeset. */
  total: number;
  /** Zero-based index of the active match, or 0 when there is none. */
  currentIndex: number;
  /**
   * True while files in the changeset are still being read, so `total` will
   * keep growing. Shown as a small spinner beside the count.
   */
  isSearching: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /**
   * Bumped by the parent each time the find shortcut fires. Any value above
   * zero re-focuses and re-selects the query, so pressing the shortcut again
   * while the bar is already open returns the reader to the input.
   */
  focusNonce?: number;
  /** Layout overrides for the floating bar (position, offsets). */
  className?: string;
};

/**
 * The find bar for the diff view, floating over the changeset like the
 * Markdown preview's search bar. It is a controlled component: the parent owns
 * the query and the match list, and this widget only renders the query, the
 * count and the navigation controls.
 *
 * `isSearching` says the changeset is still being read, so the count is not
 * final yet — the spinner beside it makes that visible instead of leaving the
 * reader to wonder why matches trickle in.
 */
export const DiffFindBar: React.FC<DiffFindBarProps> = ({
  query,
  onQueryChange,
  total,
  currentIndex,
  isSearching,
  onNext,
  onPrevious,
  onClose,
  focusNonce,
  className,
}) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // The parent mounts the bar when the shortcut opens it, so focus once here.
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Pressing the find shortcut again re-focuses and re-selects the query.
  React.useEffect(() => {
    if (focusNonce && focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusNonce]);

  const hasQuery = query.trim().length > 0;
  const countLabel = total > 0
    ? t('diffFind.countAria', { current: currentIndex + 1, total })
    : hasQuery
      ? t('diffFind.noMatches')
      : undefined;

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    // An Escape that dismisses an IME candidate window is not ours: closing the
    // bar here would collapse it mid-composition. Same contract as zoneEscape.
    if (isIMECompositionEvent(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }, [onClose, onNext, onPrevious]);

  // `z-40` sits above the sticky file header (`z-30`) inside the diff surface so
  // the bar's buttons receive their own clicks while the header is stuck. It
  // stays under the panel's resize handles (`z-50`), which must keep winning.
  return (
    <div className={cn('absolute inset-e-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-1.5 py-1 shadow-lg', className)}>
      <Icon name="search" className="ms-0.5 size-3.5 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('diffFind.placeholder')}
        aria-label={t('diffFind.placeholder')}
        className="h-7 w-40 rounded-md px-2 py-0 text-sm md:w-56"
      />
      <span
        className="min-w-12 px-1 text-center typography-micro text-muted-foreground tabular-nums"
        aria-live="polite"
        aria-label={countLabel}
      >
        {hasQuery && total === 0
          ? t('diffFind.noMatches')
          : total > 0
            ? `${currentIndex + 1}/${total}`
            : ''}
      </span>
      {isSearching && (
        <span role="status" aria-label={t('diffFind.searchingAria')} className="me-0.5 flex shrink-0">
          <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={onPrevious}
        title={t('diffFind.previousAria')}
        aria-label={t('diffFind.previousAria')}
        disabled={total === 0}
      >
        <Icon name="arrow-up" className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={onNext}
        title={t('diffFind.nextAria')}
        aria-label={t('diffFind.nextAria')}
        disabled={total === 0}
      >
        <Icon name="arrow-down" className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 p-0 text-muted-foreground"
        onClick={onClose}
        title={t('diffFind.closeAria')}
        aria-label={t('diffFind.closeAria')}
      >
        <Icon name="close" className="size-3.5" />
      </Button>
    </div>
  );
};
