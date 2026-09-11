import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { browserUrlLabel } from '@/lib/browser/url';
import type { BrowserHistoryEntry } from '@/lib/browser/history';

/**
 * Addresses already visited in this project, offered under the address bar.
 *
 * Kept deliberately plain: it is a short list of places, so it borrows the
 * app's dropdown surface rather than introducing a second look for the same
 * idea. Selection is driven from the address bar's own keyboard handling, which
 * is why the highlighted row arrives as a prop instead of being tracked here.
 */
export const BrowserAddressSuggestions: React.FC<{
  entries: readonly BrowserHistoryEntry[];
  activeIndex: number;
  onSelect: (url: string) => void;
  onForget: (url: string) => void;
  onHighlight: (index: number) => void;
}> = ({ entries, activeIndex, onSelect, onForget, onHighlight }) => {
  const { t } = useI18n();
  if (entries.length === 0) return null;

  return (
    <div
      className="oc-glass-popover oc-glass-floating absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-xl p-1"
      role="listbox"
      aria-label={t('contextPanel.browser.history.label')}
    >
      {entries.map((entry, index) => (
        <div
          key={entry.url}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1',
            index === activeIndex ? 'bg-interactive-hover' : 'hover:bg-interactive-hover',
          )}
          // Pointer down rather than click: the address bar loses focus first,
          // and a blur that closes the list would cancel the click.
          onPointerDown={(event) => {
            event.preventDefault();
            onSelect(entry.url);
          }}
          onPointerEnter={() => onHighlight(index)}
        >
          <Icon name="global" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate typography-micro text-foreground">
              {entry.title || browserUrlLabel(entry.url)}
            </div>
            <div className="truncate typography-micro text-muted-foreground">{entry.url}</div>
          </div>
          <button
            type="button"
            className={cn(
              'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity',
              'hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
            )}
            aria-label={t('contextPanel.browser.history.forget')}
            title={t('contextPanel.browser.history.forget')}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onForget(entry.url);
            }}
          >
            <Icon name="close" className="size-3" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
};
