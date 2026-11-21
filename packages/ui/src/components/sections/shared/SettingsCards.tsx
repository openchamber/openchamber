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


export const SETTINGS_CARD_GRID_CLASS = 'grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3';

const CARD_CLASS = cn(
  'group flex min-h-[132px] flex-col rounded-xl p-4 text-start',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
);

export type SettingsCardTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const TONE_CLASS = {
  success: 'bg-[var(--status-success)]/15 text-[var(--status-success)]',
  warning: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
  error: 'bg-[var(--status-error)]/15 text-[var(--status-error)]',
  info: 'bg-[var(--status-info)]/15 text-[var(--status-info)]',
  neutral: 'oc-tile-inset text-muted-foreground',
} satisfies Record<SettingsCardTone, string>;

export const SettingsCardPill: React.FC<{ tone: SettingsCardTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={cn('max-w-40 shrink-0 truncate rounded-full px-2 py-0.5 text-[0.625rem] font-medium', TONE_CLASS[tone])}>
    {children}
  </span>
);

export const SettingsCardChip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="oc-tile-inset shrink-0 rounded-full px-2 py-px text-[0.625rem] font-medium">
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
  subtitle?: string;
  description?: string;
  badges?: React.ReactNode;
  footer?: React.ReactNode;
  muted?: boolean;
  onOpen?: () => void;
  actions?: readonly SettingsCardAction[];
  actionsLabel?: string;
  control?: React.ReactNode;
}

const ActionLabel: React.FC<{ action: SettingsCardAction }> = ({ action }) => (
  <>
    {action.icon ? <Icon name={action.icon} className="size-4" /> : null}
    {action.label}
  </>
);

export const SettingsCard: React.FC<SettingsCardProps> = ({ icon, title, subtitle, description, badges, footer, muted, onOpen, actions, actionsLabel, control }) => {
  const hasActions = (actions?.length ?? 0) > 0;
  const hasControl = control != null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={cn('oc-tile-inset flex size-10 shrink-0 items-center justify-center rounded-[10px]', muted && 'opacity-60')}>
          {icon}
        </span>
        {badges ? <span className="flex min-w-0 flex-wrap justify-end gap-1">{badges}</span> : null}
      </div>
      <div className={cn('mt-3 min-w-0', muted && 'opacity-60')}>
        <div className="truncate text-sm font-semibold text-foreground" title={title}>{title}</div>
        {subtitle ? (
          <div className="mt-0.5 truncate font-mono typography-micro text-muted-foreground" title={subtitle}>{subtitle}</div>
        ) : null}
        {description ? (
          <div className="mt-1 line-clamp-2 typography-micro text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className={cn('mt-auto flex min-w-0 items-center gap-2 pt-3 typography-micro text-muted-foreground', hasControl ? 'pe-24' : hasActions && 'pe-8 pointer-fine:pe-0')}>
        {footer}
        {onOpen ? (
          <Icon
            name="arrow-right-s"
            className={cn(
              'ms-auto size-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-70',
              hasActions && !hasControl && 'hidden pointer-fine:block',
              hasActions && hasControl && 'hidden',
            )}
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
        'oc-tile oc-tile-hover h-full w-full',
      )}
    >
      {body}
    </button>
  ) : (
    <div className={cn(CARD_CLASS, 'oc-tile h-full')}>{body}</div>
  );

  if (!hasActions && !hasControl) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative" />}>
        {card}
        <div className="absolute bottom-3 inset-e-3 flex items-center gap-1">
          {hasActions && actions ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-fine:hidden"
                  aria-label={actionsLabel}
                  title={actionsLabel}
                >
                  <Icon name="more" className="size-4" />
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
          ) : null}
          {control}
        </div>
      </ContextMenuTrigger>
      {hasActions && actions ? (
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
      ) : null}
    </ContextMenu>
  );
};

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
      'oc-tile-hover items-center justify-center gap-2 text-center border border-dashed border-[color-mix(in_srgb,var(--foreground)_14%,transparent)] text-muted-foreground hover:text-foreground',
    )}
  >
    <span className="oc-tile-inset flex size-10 items-center justify-center rounded-[10px]">
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
  className?: string;
  compact?: boolean;
}> = ({ value, onChange, placeholder, className, compact = false }) => (
  <div className={cn('relative mb-4 max-w-[24rem]', className)}>
    <Icon
      name="search"
      className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      aria-hidden
    />
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      inputSize={compact ? 'compact' : 'default'}
      className="ps-7"
    />
  </div>
);

export const SettingsCardToolbar: React.FC<{
  search: { value: string; onChange: (value: string) => void; placeholder: string } | null;
  actions: React.ReactNode;
}> = ({ search, actions }) => (
  <div className="mb-4 flex flex-wrap items-center gap-2">
    {search ? <SettingsCardSearch {...search} compact className="mb-0 min-w-0 flex-1 basis-56" /> : null}
    <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div>
  </div>
);

export const SettingsBackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <Button
    variant="ghost"
    size="icon"
    className="-ms-2 h-7 w-7 shrink-0"
    onClick={onClick}
    aria-label={label}
    title={label}
  >
    <Icon name="arrow-left-s" className="size-4" />
  </Button>
);

export const SettingsCardIcon: React.FC<{ name: IconName }> = ({ name }) => (
  <Icon name={name} className="size-5 text-muted-foreground" />
);
