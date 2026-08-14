import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { ForgeProvider } from '@/lib/forge/provider';
import { useForgeLookup } from './useForgeLookup';
import type { ForgeLookupOption } from './useForgeLookup';

export interface ForgeMentionTextareaProps {
  provider: ForgeProvider;
  directory: string;
  /** Cross-repo (fork) selector, passed through to the user lookup. */
  sourceRepo?: string | null;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

/** `@`-prefixed token before the caret, e.g. `{ start: 4, query: 'octo' }` for `hey @octo|`. */
interface MentionToken {
  start: number;
  query: string;
}

const MENTION_RE = /(^|\s|[,;(])@([a-zA-Z0-9][a-zA-Z0-9-_.]*)$/;

/**
 * Detect the mention token ending at `caret` in `text`. Returns null when there
 * is no `@`-trigger in flight.
 */
const findMentionToken = (text: string, caret: number): MentionToken | null => {
  const before = text.slice(0, caret);
  const match = MENTION_RE.exec(before);
  if (!match) return null;
  const prefix = match[1] ?? '';
  return { start: caret - match[0].length + prefix.length, query: match[2] };
};

/**
 * Textarea with repo-scoped @-mention autocomplete for forge comment bodies.
 *
 * Typing `@` followed by a prefix opens a dropdown of assignable users from
 * `provider.searchUsers` (debounced). Arrow keys move the highlight, Enter/Tab
 * insert `@login ` in place of the partial token, and Escape closes the list.
 * Rendering is gated on `capabilities.userSearch` + method presence; otherwise
 * it behaves as a plain textarea.
 */
export const ForgeMentionTextarea: React.FC<ForgeMentionTextareaProps> = ({
  provider,
  directory,
  sourceRepo,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  className,
  autoFocus,
}) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = useState<MentionToken | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const hasLookup = typeof provider.searchUsers === 'function' && provider.capabilities.userSearch;
  const { options, loading } = useForgeLookup({
    provider,
    directory,
    sourceRepo,
    kind: 'users',
    query: token?.query ?? '',
  });

  useEffect(() => {
    setHighlighted(0);
  }, [options]);

  // Close on outside click.
  useEffect(() => {
    if (!token) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setToken(null);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [token]);

  const insertMention = useCallback((option: ForgeLookupOption) => {
    if (!token) return;
    const next = `${value.slice(0, token.start)}@${option.label} ${value.slice(textareaRef.current?.selectionStart ?? token.start + token.query.length)}`;
    onChange(next);
    setToken(null);
    // Restore the caret after the inserted mention.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        const caret = token.start + option.label.length + 2;
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }, [onChange, token, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!token) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((prev) => (options.length ? (prev + 1) % options.length : 0));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((prev) => (options.length ? (prev - 1 + options.length) % options.length : 0));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setToken(null);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (options[highlighted]) {
        event.preventDefault();
        insertMention(options[highlighted]);
      }
      return;
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value;
    onChange(next);
    if (hasLookup) {
      setToken(findMentionToken(next, event.target.selectionStart ?? next.length));
    }
  };

  const openToken = token && hasLookup;
  const filtered = useMemo(
    () => (token?.query ? options.filter((option) => option.label.toLowerCase().includes(token.query.toLowerCase())) : options),
    [options, token?.query],
  );

  return (
    <div ref={rootRef} className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        autoFocus={autoFocus}
        className={className}
        aria-expanded={Boolean(openToken)}
        aria-controls={openToken ? 'forge-mention-list' : undefined}
        aria-activedescendant={openToken && filtered[highlighted] ? `forge-mention-${filtered[highlighted].key}` : undefined}
      />
      {openToken ? (
        <div
          id="forge-mention-list"
          role="listbox"
          className="absolute left-0 right-0 bottom-full z-50 mb-1 max-h-44 min-w-0 overflow-hidden rounded-md border border-border/60 bg-[var(--surface-elevated)] shadow-lg"
        >
          {loading ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5 typography-micro text-muted-foreground">
              <Icon name="loader-4" className="size-3 animate-spin" />
              {t('forge.lookup.loading')}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-1.5 typography-micro text-muted-foreground">{t('forge.lookup.empty')}</div>
          ) : (
            filtered.map((option, index) => (
              <div
                key={option.key}
                id={`forge-mention-${option.key}`}
                role="option"
                aria-selected={index === highlighted}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 px-2 py-1 typography-micro text-foreground',
                  index === highlighted && 'bg-interactive-selection',
                )}
                onClick={() => insertMention(option)}
                onMouseMove={() => setHighlighted(index)}
              >
                {option.avatarUrl ? (
                  <img src={option.avatarUrl} alt="" className="size-3.5 shrink-0 rounded-full object-cover" />
                ) : null}
                <span className="min-w-0 truncate">{option.label}</span>
                {option.secondary ? <span className="truncate text-muted-foreground">{option.secondary}</span> : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
};