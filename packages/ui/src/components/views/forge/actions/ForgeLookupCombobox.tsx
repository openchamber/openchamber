import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import type { ForgeProvider } from '@/lib/forge/provider';
import { useForgeLookup } from './useForgeLookup';
import type { ForgeLookupKind, ForgeLookupOption } from './useForgeLookup';

export interface ForgeLookupComboboxProps {
  provider: ForgeProvider;
  directory: string;
  /** Cross-repo (fork) selector, passed through to the facade. */
  sourceRepo?: string | null;
  kind: ForgeLookupKind;
  value: string;
  onChange: (value: string) => void;
  /** Called when the user picks an option (not when they type free text). */
  onSelect: (option: ForgeLookupOption) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

const normalizeColor = (color?: string): string | null => {
  if (!color) return null;
  const value = color.trim();
  if (!value) return null;
  return value.startsWith('#') ? value : `#${value}`;
};

/**
 * Search-as-you-type combobox for forge metadata fields (assignees, labels,
 * milestones, branches, tags). Renders a plain input until the provider offers
 * a matching `search*` method; once it does, typing opens a dropdown of
 * repo-scoped options with keyboard navigation. Selecting an option calls
 * `onSelect`; free text still passes through `onChange` so surfaces keep their
 * free-entry fallback.
 */
export const ForgeLookupCombobox: React.FC<ForgeLookupComboboxProps> = ({
  provider,
  directory,
  sourceRepo,
  kind,
  value,
  onChange,
  onSelect,
  placeholder,
  ariaLabel,
  disabled,
  className,
}) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const { options, loading } = useForgeLookup({ provider, directory, sourceRepo, kind, query: value });

  const hasLookup = useMemo(() => {
    switch (kind) {
      case 'users':
        return typeof provider.searchUsers === 'function' && provider.capabilities.userSearch;
      case 'labels':
        return typeof provider.searchLabels === 'function' && provider.capabilities.labelSearch;
      case 'milestones':
        return typeof provider.searchMilestones === 'function' && provider.capabilities.milestoneSearch;
      case 'branches':
        return typeof provider.searchBranches === 'function' && provider.capabilities.branchSearch;
      case 'tags':
        return typeof provider.searchTags === 'function' && provider.capabilities.tagSearch;
    }
  }, [kind, provider]);

  useEffect(() => {
    setHighlighted(0);
  }, [options]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  const choose = useCallback((option: ForgeLookupOption) => {
    setOpen(false);
    onSelect(option);
  }, [onSelect]);

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          if (event.target.value.trim()) setOpen(true);
        }}
        onFocus={() => {
          if (hasLookup) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            if (!open) {
              setOpen(true);
              return;
            }
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
            if (open) {
              event.preventDefault();
              setOpen(false);
            }
            return;
          }
          if (event.key === 'Enter' && open && options[highlighted]) {
            event.preventDefault();
            choose(options[highlighted]);
            return;
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? 'forge-lookup-list' : undefined}
        aria-activedescendant={open && options[highlighted] ? `forge-lookup-${kind}-${options[highlighted].key}` : undefined}
        className={cn('h-6 w-36 appearance-none rounded-md bg-[var(--surface-elevated)] px-2 typography-micro text-foreground placeholder:text-muted-foreground', 'ring-1 ring-inset ring-border/60 focus:ring-2 focus:ring-[var(--interactive-focus-ring)] focus-visible:outline-none', className)}
      />
      {open && hasLookup ? (
        <div
          id="forge-lookup-list"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 min-w-0 max-w-full overflow-hidden rounded-md border border-border/60 bg-[var(--surface-elevated)] shadow-lg"
        >
          <ScrollableOverlay preventOverscroll outerClassName="max-h-44 min-h-0">
            {loading ? (
              <div className="flex items-center gap-1.5 px-2 py-1.5 typography-micro text-muted-foreground">
                <Icon name="loader-4" className="size-3 animate-spin" />
                {t('forge.lookup.loading')}
              </div>
            ) : options.length === 0 ? (
              <div className="px-2 py-1.5 typography-micro text-muted-foreground">{t('forge.lookup.empty')}</div>
            ) : (
              options.map((option, index) => (
                <div
                  key={option.key}
                  id={`forge-lookup-${kind}-${option.key}`}
                  role="option"
                  aria-selected={index === highlighted}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 px-2 py-1 typography-micro text-foreground',
                    index === highlighted && 'bg-interactive-selection',
                  )}
                  onClick={() => choose(option)}
                  onMouseMove={() => setHighlighted(index)}
                >
                  {option.avatarUrl ? (
                    <img src={option.avatarUrl} alt="" className="size-3.5 shrink-0 rounded-full object-cover" />
                  ) : option.color ? (
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: normalizeColor(option.color) ?? 'var(--status-info)' }} />
                  ) : null}
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.secondary ? (
                    <span className="truncate text-muted-foreground">{option.secondary}</span>
                  ) : null}
                </div>
              ))
            )}
          </ScrollableOverlay>
        </div>
      ) : null}
    </div>
  );
};