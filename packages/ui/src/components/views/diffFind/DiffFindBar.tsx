import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const DIFF_FIND_BAR_ATTR = 'data-diff-find-bar';

export type DiffFindBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  total: number;
  currentIndex: number;
  isSearching: boolean;
  failedCount?: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  focusNonce?: number;
  className?: string;
};

export const DiffFindBar: React.FC<DiffFindBarProps> = ({
  query,
  onQueryChange,
  total,
  currentIndex,
  isSearching,
  failedCount = 0,
  onNext,
  onPrevious,
  onClose,
  focusNonce,
  className,
}) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (focusNonce && focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusNonce]);

  const hasQuery = query.trim().length > 0 && !isSearching;
  const matchesLabel = total > 0
    ? t('diffFind.countAria', { current: currentIndex + 1, total })
    : hasQuery
      ? t('diffFind.noMatches')
      : undefined;
  const countLabel = isSearching
    ? [matchesLabel, t('diffFind.searchingAria')].filter(Boolean).join(', ')
    : matchesLabel;

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
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

  return (
    <div data-diff-find-bar="" className={cn('absolute inset-e-3 top-3 z-40 flex flex-col rounded-lg border border-edge bg-[var(--surface-elevated)] px-1.5 py-1 shadow-lg', className)}>
      <div className="flex items-center gap-1">
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
              ? `${currentIndex + 1}/${total}${isSearching ? '+' : ''}`
              : ''}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-muted-foreground"
                onClick={onPrevious}
                aria-label={t('diffFind.previousAria')}
                disabled={total === 0}
              >
                <Icon name="arrow-up" className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('diffFind.previousAria')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-muted-foreground"
                onClick={onNext}
                aria-label={t('diffFind.nextAria')}
                disabled={total === 0}
              >
                <Icon name="arrow-down" className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('diffFind.nextAria')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-6 p-0 text-muted-foreground"
              onClick={onClose}
              aria-label={t('diffFind.closeAria')}
            >
              <Icon name="close" className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('diffFind.closeAria')}</TooltipContent>
        </Tooltip>
      </div>
      {failedCount > 0 && (
        <p className="w-0 min-w-full px-1 pb-0.5 typography-micro text-status-warning">
          {t('diffFind.failedCount', { count: failedCount })}
        </p>
      )}
    </div>
  );
};
