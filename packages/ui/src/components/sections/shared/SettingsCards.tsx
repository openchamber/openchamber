import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

/**
 * Card grid for Settings pages that browse a set of things with a glanceable
 * state (providers, MCP servers, plugins): a grid of cards, each opening a
 * detail screen with a back arrow. Pages that edit long text keep the
 * list-plus-editor layout instead.
 */

export const SETTINGS_CARD_GRID_CLASS = 'grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3';

const CARD_CLASS = cn(
  'group flex min-h-[132px] flex-col rounded-xl border p-4 text-left transition-colors duration-150',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
);

export type SettingsCardTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const TONE_CLASS = {
  success: 'bg-[var(--status-success)]/15 text-[var(--status-success)]',
  warning: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
  error: 'bg-[var(--status-error)]/15 text-[var(--status-error)]',
  info: 'bg-[var(--status-info)]/15 text-[var(--status-info)]',
  neutral: 'bg-[var(--surface-muted)] text-muted-foreground',
} satisfies Record<SettingsCardTone, string>;

export const SettingsCardPill: React.FC<{ tone: SettingsCardTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={cn('max-w-40 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', TONE_CLASS[tone])}>
    {children}
  </span>
);

/** Small outlined chip for the card footer (scope, source). */
export const SettingsCardChip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="shrink-0 rounded-full border border-[var(--interactive-border)] px-2 py-px text-[10px] font-medium">
    {children}
  </span>
);

export interface SettingsCardAction {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  onSelect: () => void;
}

interface SettingsCardProps {
  icon: React.ReactNode;
  title: string;
  /** Monospace second line: an id, command or URL. */
  subtitle?: string;
  /** Top-right pills (status, update available). */
  badges?: React.ReactNode;
  /** Bottom row content: counts and chips. */
  footer?: React.ReactNode;
  /** Dims the card for things that are present but switched off. */
  muted?: boolean;
  /** Omitted for display-only items, which render as a plain card. */
  onOpen?: () => void;
  /** Row actions, offered from the card's ⋯ button and on right-click. */
  actions?: readonly SettingsCardAction[];
  /** Accessible name for the ⋯ button. */
  actionsLabel?: string;
}

const ActionLabel: React.FC<{ action: SettingsCardAction }> = ({ action }) => (
  <>
    {action.icon ? <Icon name={action.icon} className="size-4" /> : null}
    {action.label}
  </>
);

export const SettingsCard: React.FC<SettingsCardProps> = ({ icon, title, subtitle, badges, footer, muted, onOpen, actions, actionsLabel }) => {
  const hasActions = (actions?.length ?? 0) > 0;
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]', muted && 'opacity-60')}>
          {icon}
        </span>
        {badges ? <span className="flex min-w-0 flex-wrap justify-end gap-1">{badges}</span> : null}
      </div>
      <div className={cn('mt-3 min-w-0', muted && 'opacity-60')}>
        <div className="truncate text-sm font-semibold text-foreground" title={title}>{title}</div>
        {subtitle ? (
          <div className="mt-0.5 truncate font-mono typography-micro text-muted-foreground" title={subtitle}>{subtitle}</div>
        ) : null}
      </div>
      <div className={cn('mt-auto flex min-w-0 items-center gap-2 pt-3 typography-micro text-muted-foreground', hasActions && 'pr-8')}>
        {footer}
        {onOpen && !hasActions ? (
          <Icon
            name="arrow-right-s"
            className="ml-auto size-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-70"
            aria-hidden
          />
        ) : null}
      </div>
    </>
  );

  const card = onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        CARD_CLASS,
        'h-full w-full border-[var(--interactive-border)] bg-[var(--surface-elevated)] hover:border-[var(--interactive-border-hover)] hover:bg-[var(--interactive-hover)]/50',
      )}
    >
      {body}
    </button>
  ) : (
    <div className={cn(CARD_CLASS, 'h-full border-[var(--interactive-border)] bg-[var(--surface-elevated)]')}>{body}</div>
  );

  if (!hasActions || !actions) return card;

  // The ⋯ button sits over the card as a sibling of the card button, never
  // inside it, so the two stay separate controls.
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative" />}>
        {card}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute bottom-3 right-3 h-7 w-7 text-muted-foreground opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={actionsLabel}
              title={actionsLabel}
            >
              <Icon name="more-2" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-fit min-w-32">
            {actions.map((action) => (
              <DropdownMenuItem key={action.label} variant={action.destructive ? 'destructive' : 'default'} onClick={action.onSelect}>
                <ActionLabel action={action} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-fit min-w-32">
        {actions.map((action) => (
          <ContextMenuItem
            key={action.label}
            className={cn(action.destructive && 'text-destructive focus:text-destructive')}
            onClick={action.onSelect}
          >
            <ActionLabel action={action} />
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
};

/** Dashed leading card that starts adding a new item. */
export const SettingsAddCard: React.FC<{
  label: string;
  hint?: string;
  onClick: () => void;
  settingsItem?: string;
}> = ({ label, hint, onClick, settingsItem }) => (
  <button
    type="button"
    onClick={onClick}
    data-settings-item={settingsItem}
    className={cn(
      CARD_CLASS,
      'items-center justify-center gap-2 border-dashed border-[var(--interactive-border)] text-muted-foreground hover:bg-[var(--interactive-hover)]/50 hover:text-foreground',
    )}
  >
    <span className="flex size-10 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
      <Icon name="add" className="size-5" />
    </span>
    <span className="typography-ui-label font-medium">{label}</span>
    {hint ? <span className="typography-micro">{hint}</span> : null}
  </button>
);

export const SettingsCardSearch: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}> = ({ value, onChange, placeholder }) => (
  <div className="relative mb-4 max-w-[24rem]">
    <Icon
      name="search"
      className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      aria-hidden
    />
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="h-9 pl-8"
    />
  </div>
);

/** Back arrow placed before a detail screen's title. */
export const SettingsBackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <Button
    variant="ghost"
    size="icon"
    className="-ml-2 h-7 w-7 shrink-0"
    onClick={onClick}
    aria-label={label}
    title={label}
  >
    <Icon name="arrow-left-s" className="size-4" />
  </Button>
);

/** Icon tile content for cards without a logo of their own. */
export const SettingsCardIcon: React.FC<{ name: IconName }> = ({ name }) => (
  <Icon name={name} className="size-5 text-muted-foreground" />
);
