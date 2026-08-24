import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState<MentionToken | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number; flip: boolean } | null>(null);

  const hasLookup = typeof provider.searchUsers === 'function' && provider.capabilities.userSearch;
  const { options, loading, initialized } = useForgeLookup({
    provider,
    directory,
    sourceRepo,
    kind: 'users',
    query: token?.query ?? '',
  });

  useEffect(() => {
    setHighlighted(0);
  }, [options]);

  // Close on outside click. The mention list renders in a portal (so it
  // escapes the clipped, scrollable forge surfaces), so both the trigger and
  // the portal panel count as "inside".
  useEffect(() => {
    if (!token) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && panelRef.current) {
        if (rootRef.current.contains(target) || panelRef.current.contains(target)) return;
      }
      setToken(null);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [token]);

  // Position the portal panel from the textarea's viewport rect. It opens
  // above the field and flips below when there is no room above it.
  const mentionOpen = token !== null && hasLookup;
  useEffect(() => {
    if (!mentionOpen) {
      setPanelPos(null);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    const gap = 4;
    const maxHeight = 176; // matches max-h-44
    const edge = 8;
    const width = Math.min(rect.width, window.innerWidth - edge * 2);
    const left = Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge));
    const flip = rect.top - gap < edge && rect.bottom + gap + maxHeight <= window.innerHeight - edge;
    setPanelPos({ top: flip ? rect.bottom + gap : rect.top - gap, left, width, flip });
  }, [mentionOpen]);

  // Scrolling the page/surfaces under a portal dropdown would leave it
  // detached from its field; close unless the interaction is inside the
  // panel (its own scrollable list) or the trigger.
  useEffect(() => {
    if (!mentionOpen) return;
    const closeOnScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && panelRef.current) {
        if (rootRef.current.contains(target) || panelRef.current.contains(target)) return;
      }
      setToken(null);
    };
    const closeOnResize = () => setToken(null);
    document.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [mentionOpen]);

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
      {openToken && panelPos
        ? createPortal(
            <div
              ref={panelRef}
              id="forge-mention-list"
              role="listbox"
              className="z-50 min-w-0 max-w-full max-h-44 overflow-y-auto rounded-md border border-border/60 bg-[var(--surface-elevated)] shadow-lg"
              style={{
                position: 'fixed',
                top: panelPos.top,
                left: panelPos.left,
                width: panelPos.width,
                transform: panelPos.flip ? undefined : 'translateY(-100%)',
              }}
            >
              {loading || !initialized ? (
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};