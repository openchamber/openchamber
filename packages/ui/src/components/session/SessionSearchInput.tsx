import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PICKER_SEARCH_INPUT_CLASS } from '@/components/ui/MobileSheetList';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SessionSearchInputProps = {
  value: string;
  onSearch: (query: string) => void;
  placeholder: string;
  clearLabel: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onClose?: () => void;
  active?: boolean;
  mobile?: boolean;
  /** Replaces the Enter hint on the left of the hint row (e.g. a match count). */
  leadingHint?: React.ReactNode;
  /** Right-aligned hint on the same row as the Enter hint. */
  trailingHint?: React.ReactNode;
  mode?: 'submit' | 'live';
  debounceMs?: number;
};

// Keep draft edits local until a submission or live debounce commits them.
export function SessionSearchInput({
  value, onSearch, placeholder, clearLabel, inputRef, onClose, active = true, mobile = false,
  leadingHint, trailingHint, mode = 'submit', debounceMs = 100,
}: SessionSearchInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value);
  const composing = React.useRef(false);
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const hintId = React.useId();
  const timer = React.useRef<number | null>(null);
  const cancelPendingSearch = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  React.useLayoutEffect(() => {
    setDraft(value);
    composing.current = false;
    cancelPendingSearch();
  }, [value, active]);

  React.useEffect(() => () => cancelPendingSearch(), []);

  const clear = () => {
    if (!active) return;
    setDraft('');
    cancelPendingSearch();
    if (value !== '') onSearch('');
  };

  const scheduleSearch = (next: string) => {
    cancelPendingSearch();
    if (!active || composing.current) return;
    const query = next.trim();
    if (query.length === 0) {
      if (value !== '') onSearch('');
    } else if (mode === 'live') {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onSearch(query);
      }, debounceMs);
    }
  };

  return (
    <div data-session-search-input>
      <div className={cn('relative', mobile && 'border-b border-edge-muted py-1')}>
        <Icon name="search" className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground', mobile ? 'inset-s-2.5 size-3.5' : 'inset-s-2 size-4')} />
        <Input
          ref={ref}
          value={draft}
          aria-label={placeholder}
          aria-describedby={mobile ? undefined : hintId}
          enterKeyHint="search"
          placeholder={placeholder}
          className={mobile ? cn(PICKER_SEARCH_INPUT_CLASS, 'pe-8') : 'h-8 w-full rounded-md border border-border bg-transparent ps-8 pe-8 typography-ui-label text-foreground'}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            scheduleSearch(next);
          }}
          onCompositionStart={() => { composing.current = true; cancelPendingSearch(); }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setDraft(event.currentTarget.value);
            scheduleSearch(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (!active || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              const query = event.currentTarget.value.trim();
              cancelPendingSearch();
              if (!event.repeat && query !== value) onSearch(query);
            } else if (event.key === 'Escape' && (draft.length > 0 || value.length > 0 || onClose)) {
              event.preventDefault();
              event.stopPropagation();
              if (draft.length > 0 || value.length > 0) clear();
              else onClose?.();
            }
          }}
        />
        {draft.length > 0 || value.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={clearLabel}
            className={cn('absolute inset-e-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground', mobile && 'inset-e-0')}
            onClick={() => { clear(); ref.current?.focus(); }}
          >
            <Icon name="close" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {/* The phone keyboard's own search key explains itself; the hint row is desktop-only. */}
      {mobile ? null : (
        <div className="mt-1 flex items-center justify-between gap-2 typography-micro text-muted-foreground">
          <p id={hintId} className="min-w-0 truncate">{leadingHint ?? (mode === 'submit' ? t('sessions.search.submitHint') : null)}</p>
          {trailingHint ? <span className="shrink-0">{trailingHint}</span> : null}
        </div>
      )}
    </div>
  );
}
