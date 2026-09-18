import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
};

// Draft text stays here: typing must not invalidate the session tree or run its
// search projection. Parents receive only submitted queries and explicit clears.
export function SessionSearchInput({
  value, onSearch, placeholder, clearLabel, inputRef, onClose, active = true, mobile = false,
}: SessionSearchInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value);
  const composing = React.useRef(false);
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const hintId = React.useId();

  React.useLayoutEffect(() => {
    setDraft(value);
    composing.current = false;
  }, [value, active]);

  const clear = () => {
    if (!active) return;
    setDraft('');
    if (value !== '') onSearch('');
  };

  return (
    <div>
      <div className="relative">
        <Icon name="search" className={cn('pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground', mobile ? 'left-3' : 'left-2')} />
        <Input
          ref={ref}
          value={draft}
          aria-label={placeholder}
          aria-describedby={hintId}
          enterKeyHint="search"
          placeholder={placeholder}
          className={mobile ? 'h-11 pl-9 pr-10' : 'h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-8 typography-ui-label text-foreground'}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (active && !composing.current && next.trim().length === 0 && value !== '') onSearch('');
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (active && event.currentTarget.value.trim().length === 0 && value !== '') onSearch('');
          }}
          onKeyDown={(event) => {
            if (!active || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              const query = event.currentTarget.value.trim();
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
            className={cn('absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground', mobile && 'right-1.5 size-8')}
            onClick={() => { clear(); ref.current?.focus(); }}
          >
            <Icon name="close" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <p id={hintId} className="mt-1 typography-micro text-muted-foreground">{t('sessions.search.submitHint')}</p>
    </div>
  );
}
