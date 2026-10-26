import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/**
 * The panel's search, floating over the top of the list the way the chat's
 * search floats over the conversation. It opens from the search button in the
 * panel header and filters every section at once; the section tabs show where
 * the matches are. Escape or the close button closes it and clears the query.
 */
export const KnowledgeSearchBar: React.FC<{
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  /** No section has a match for a non-empty query. */
  nothingFound: boolean;
  /** Bumped every time the search is opened: focus and select the query. */
  focusRequest: number;
  onClose: () => void;
}> = ({ query, onQueryChange, placeholder, nothingFound, focusRequest, onClose }) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  return (
    <div
      role="search"
      className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-[var(--surface-elevated)] py-1 ps-2.5 pe-1 shadow-md"
    >
      <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 w-48 min-w-0 bg-transparent typography-meta text-foreground outline-none placeholder:text-muted-foreground"
      />
      {nothingFound ? (
        <span className="shrink-0 typography-micro text-muted-foreground" role="status" aria-live="polite">
          {t('chat.search.noResults')}
        </span>
      ) : null}
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('chat.search.close')}>
        <Icon name="close" className="h-4 w-4" />
      </Button>
    </div>
  );
};
