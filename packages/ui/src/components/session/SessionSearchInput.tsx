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
  /**
   * A narrow list: no hint row and no Enter/Esc hints. A leadingHint (the
   * match count) sits on the field's own line, so the header keeps one height
   * whether a search is applied or not.
   */
  compact?: boolean;
  mode?: 'submit' | 'live';
  debounceMs?: number;
  chips?: React.ReactNode;
  onRemoveLastChip?: () => void;
  onClearFilters?: () => void;
  onCommit?: (text: string) => void;
};

// Keep draft edits local until a submission or live debounce commits them.
export function SessionSearchInput({
  value, onSearch, placeholder, clearLabel, inputRef, onClose, active = true, mobile = false,
  leadingHint, trailingHint, compact = false, mode = 'submit', debounceMs = 100, chips, onRemoveLastChip, onClearFilters, onCommit,
}: SessionSearchInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value);
  const [syncTick, setSyncTick] = React.useState(0);
  const composing = React.useRef(false);
  const committedDraft = React.useRef(value);
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const hintId = React.useId();
  // The phone keyboard's own search key explains itself, so mobile has no hints.
  // A compact field keeps the match count, which is feedback about the search
  // rather than a hint, beside it instead of on a row of its own.
  const showHintRow = !mobile && !compact;
  const inlineHint = !mobile && compact && leadingHint != null ? leadingHint : null;
  // Only an element that is rendered may describe the field.
  const describedBy = showHintRow || inlineHint != null ? hintId : undefined;
  const timer = React.useRef<number | null>(null);
  const cancelPendingSearch = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  React.useLayoutEffect(() => {
    setDraft(value);
    committedDraft.current = value;
    composing.current = false;
    cancelPendingSearch();
  }, [value, active, syncTick]);

  React.useEffect(() => () => cancelPendingSearch(), []);

  const commit = (text: string) => {
    cancelPendingSearch();
    if (onCommit) {
      committedDraft.current = text;
      onCommit(text);
      setSyncTick((tick) => tick + 1);
    }
    else {
      const query = text.trim();
      if (query !== value) onSearch(query);
    }
  };
  const clearSearch = () => {
    if (!active) return;
    setDraft('');
    cancelPendingSearch();
    if (onCommit) {
      if (draft !== '' || value !== '') {
        onCommit('');
        setSyncTick((tick) => tick + 1);
      }
    } else if (value !== '') onSearch('');
  };

  const scheduleSearch = (next: string) => {
    cancelPendingSearch();
    if (!active || composing.current) return;
    const query = next.trim();
    if (query.length === 0) {
      if (value !== '') {
        onSearch('');
        if (onCommit) setSyncTick((tick) => tick + 1);
      }
    } else if (mode === 'live') {
      timer.current = window.setTimeout(() => {
          timer.current = null;
          onSearch(onCommit ? next : query);
          if (onCommit) setSyncTick((tick) => tick + 1);
      }, debounceMs);
    }
  };

  const hasChips = chips != null;

  return (
    <div data-session-search-input className={inlineHint != null ? 'flex items-center gap-2' : undefined}>
      <div className={cn('relative', hasChips && (mobile ? 'flex flex-wrap items-center gap-x-1 border-b border-edge-muted py-1 ps-8 pe-8' : 'flex min-h-8 flex-wrap items-center gap-x-1 gap-y-1 rounded-md border border-border bg-transparent py-[3px] ps-8 pe-8 oc-raised oc-field hover:[&:not(:focus-within)]:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))]'), !hasChips && mobile && 'border-b border-edge-muted py-1', inlineHint != null && 'min-w-0 flex-1')}>
        <Icon name="search" className={cn('pointer-events-none absolute -translate-y-1/2 text-muted-foreground', hasChips ? mobile ? 'inset-s-2.5 top-[26px] size-3.5' : 'inset-s-2 top-[15px] size-4' : mobile ? 'inset-s-2.5 top-1/2 size-3.5' : 'inset-s-2 top-1/2 size-4')} />
        <div
          className="contents"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('[data-search-filter-chip-remove]')) ref.current?.focus();
          }}
        >
          {chips}
        </div>
        <Input
          ref={ref}
          value={draft}
          aria-label={placeholder}
          aria-describedby={describedBy}
          enterKeyHint="search"
          placeholder={hasChips ? '' : placeholder}
          className={hasChips ? mobile ? cn(PICKER_SEARCH_INPUT_CLASS, 'min-w-20 flex-1 basis-20 ps-0 pe-0 shadow-none dark:bg-transparent') : 'h-6 min-w-20 flex-1 basis-20 rounded-none border-0 bg-transparent p-0 shadow-none dark:bg-transparent typography-ui-label text-foreground hover:[&:not(:focus)]:[background-image:none]' : mobile ? cn(PICKER_SEARCH_INPUT_CLASS, 'pe-8') : 'h-8 w-full rounded-md border border-border bg-transparent ps-8 pe-8 typography-ui-label text-foreground'}
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
            if (event.key === 'Backspace' && hasChips && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && onRemoveLastChip) {
              event.preventDefault();
              event.stopPropagation();
              onRemoveLastChip();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) commit(event.currentTarget.value);
            } else if (event.key === 'Escape' && (draft.length > 0 || value.length > 0 || onClose)) {
              event.preventDefault();
              event.stopPropagation();
              if (draft.length > 0 || value.length > 0) clearSearch();
              else onClose?.();
            }
          }}
          onBlur={(event) => {
            if (active && onCommit && !composing.current && event.currentTarget.value !== value && event.currentTarget.value !== committedDraft.current) commit(event.currentTarget.value);
          }}
        />
        {draft.length > 0 || value.length > 0 || hasChips ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={clearLabel}
            className={cn('absolute inset-e-1 size-6 -translate-y-1/2 text-muted-foreground', hasChips ? mobile ? 'inset-e-0 top-[26px]' : 'top-[15px]' : 'top-1/2', !hasChips && mobile && 'inset-e-0')}
            onClick={() => { clearSearch(); onClearFilters?.(); ref.current?.focus(); }}
          >
            <Icon name="close" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {inlineHint != null ? (
        <p id={hintId} className="shrink-0 typography-micro text-muted-foreground">{inlineHint}</p>
      ) : null}
      {showHintRow ? (
        <div className="mt-1 flex items-center justify-between gap-2 typography-micro text-muted-foreground">
          <p id={hintId} className="min-w-0 truncate">{leadingHint ?? (mode === 'submit' ? t('sessions.search.submitHint') : null)}</p>
          {trailingHint ? <span className="shrink-0">{trailingHint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
