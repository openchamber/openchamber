import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PICKER_SEARCH_INPUT_CLASS } from '@/components/ui/MobileSheetList';
import { cn } from '@/lib/utils';

type SessionSearchInputProps = {
  value: string;
  onSearch: (query: string) => void;
  placeholder: string;
  /** The field's accessible name, when the placeholder is too short to be one. */
  label?: string;
  clearLabel: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onClose?: () => void;
  active?: boolean;
  mobile?: boolean;
  debounceMs?: number;
  /** Sits inside the field, before the clear button: a status mark, a count, the Search in menu. */
  trailing?: React.ReactNode;
  /**
   * A field that shares a toolbar row: at rest it is an icon and a word with
   * no field chrome, and takes the field look once focused or filled.
   */
  quiet?: boolean;
};

const FIELD_CLASS = 'rounded-md border border-border oc-raised oc-field hover:[&:not(:focus-within)]:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))]';
const QUIET_REST_CLASS = 'rounded-md border border-transparent hover:bg-interactive-hover';
const BARE_INPUT_CLASS = 'h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 shadow-none dark:bg-transparent typography-ui-label text-foreground hover:[&:not(:focus)]:[background-image:none]';

// Keeps the draft local and commits it on a debounce, so typing renders only the field.
export function SessionSearchInput({
  value, onSearch, placeholder, label, clearLabel, inputRef, onClose, active = true, mobile = false, debounceMs = 100, trailing, quiet = false,
}: SessionSearchInputProps) {
  const [draft, setDraft] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  const composing = React.useRef(false);
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const timer = React.useRef<number | null>(null);
  const cancelPendingSearch = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  React.useLayoutEffect(() => {
    // The parent holds the trimmed query. When it only confirms what the draft
    // already says, the draft keeps its own spacing, so a space typed before
    // the debounce fired is still there for the next word.
    setDraft((current) => (current.trim() === value ? current : value));
    composing.current = false;
    cancelPendingSearch();
  }, [value, active]);

  React.useEffect(() => () => cancelPendingSearch(), []);

  const commit = (text: string) => {
    cancelPendingSearch();
    const query = text.trim();
    if (query !== value) onSearch(query);
  };
  const clearSearch = () => {
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
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onSearch(query);
    }, debounceMs);
  };

  const filled = draft.length > 0 || value.length > 0;
  const atRest = quiet && !focused && !filled;

  return (
    <div
      data-session-search-input
      // The whole field is the way in: a press on its icon or its padding puts the caret in the input.
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest('input, button')) return;
        event.preventDefault();
        ref.current?.focus();
      }}
      className={cn(
        'relative flex min-w-0 cursor-text items-center gap-0.5',
        mobile ? 'border-b border-edge-muted py-1 ps-8' : cn('h-8 pe-1', quiet ? 'ps-7' : 'ps-8', atRest ? QUIET_REST_CLASS : FIELD_CLASS),
      )}
    >
      <Icon name="search" className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground', mobile ? 'inset-s-2.5 size-3.5' : cn('size-4', quiet ? 'inset-s-1.5' : 'inset-s-2'))} />
      <Input
        ref={ref}
        value={draft}
        aria-label={label ?? placeholder}
        enterKeyHint="search"
        placeholder={placeholder}
        className={mobile ? cn(PICKER_SEARCH_INPUT_CLASS, 'min-w-0 flex-1 ps-0 pe-0 shadow-none dark:bg-transparent') : BARE_INPUT_CLASS}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
            if (!event.repeat) commit(event.currentTarget.value);
          } else if (event.key === 'Escape' && (filled || onClose)) {
            event.preventDefault();
            event.stopPropagation();
            if (filled) clearSearch();
            else onClose?.();
          }
        }}
      />
      {trailing}
      {filled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          className="size-6 shrink-0 text-muted-foreground"
          onClick={() => { clearSearch(); ref.current?.focus(); }}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
