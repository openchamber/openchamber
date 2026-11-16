import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Caption of a group of rows: in the phone's sheets and the desktop agent and effort menus. */
export const PICKER_SECTION_HEADER_CLASS = 'typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 px-2 py-1.5';

/** The borderless search field of pickers, under a hairline. */
export const PICKER_SEARCH_INPUT_CLASS = 'h-7 rounded-none bg-transparent ps-8 pe-0 typography-meta ring-0 hover:[&:not(:focus)]:bg-transparent hover:[&:not(:focus)]:[background-image:none] focus:ring-0 focus-visible:ring-0';

interface MobileSheetSectionProps {
  title: string;
  /** A short note at the end of the caption. */
  hint?: string;
  children: React.ReactNode;
}

export const MobileSheetSection: React.FC<MobileSheetSectionProps> = ({ title, hint, children }) => (
  <div role="group" aria-label={title} className="pt-2 first:pt-0">
    <div className={PICKER_SECTION_HEADER_CLASS}>
      <span className="min-w-0 truncate">{title}</span>
      {hint ? <span className="ms-auto flex-shrink-0 font-normal normal-case tracking-normal">{hint}</span> : null}
    </div>
    {children}
  </div>
);

interface MobileSheetRowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  icon?: IconName;
  /** Stands in for the icon: an agent's dot, a provider or project mark. */
  leading?: React.ReactNode;
  /** Quiet text after the label: a count, a time. */
  meta?: React.ReactNode;
  /** A control of its own at the end of the row, beside the row's button. */
  action?: React.ReactNode;
  selected?: boolean;
  destructive?: boolean;
}

/**
 * One line of a bottom sheet: an option or an action. The chosen row takes the
 * selection fill and a check, as the model and agent sheets show it. Its height
 * follows the model sheet's rows: the touch floor under a finger.
 */
export const MobileSheetRow: React.FC<MobileSheetRowProps> = ({
  icon,
  leading,
  meta,
  action,
  selected = false,
  destructive = false,
  children,
  ...buttonProps
}) => (
  <div
    className={cn(
      'flex min-h-[31px] items-center gap-1 rounded-md [@media(pointer:coarse)]:min-h-11',
      action && 'pe-1',
      selected && 'bg-interactive-selection text-interactive-selection-foreground',
      destructive && 'text-status-error',
    )}
  >
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      {...buttonProps}
      className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-md px-2 text-start typography-meta font-medium touch-manipulation focus:outline-none active:bg-interactive-hover disabled:opacity-50"
    >
      {icon ? <Icon name={icon} className={cn('size-4 flex-shrink-0', !destructive && !selected && 'text-muted-foreground')} /> : leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta ? <span className="flex-shrink-0 font-normal text-muted-foreground">{meta}</span> : null}
      {selected ? <Icon name="check" className="size-4 flex-shrink-0 text-inherit" /> : null}
    </button>
    {action}
  </div>
);

interface MobileSheetSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Buttons at the end of the search row. */
  actions?: React.ReactNode;
}

/**
 * The search of a phone surface: for `MobileOverlayPanel`'s `subheader`, or a
 * row above a list. It stays in place while the list scrolls. No autofocus: the
 * keyboard would rise over the list the user came to scan.
 */
export const MobileSheetSearch: React.FC<MobileSheetSearchProps> = ({ value, onChange, placeholder, actions }) => (
  <div className="flex items-center gap-1 border-b border-edge-muted px-2 py-1">
    <div className="relative min-w-0 flex-1">
      <Icon name="search" className="absolute inset-s-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={placeholder}
        placeholder={placeholder}
        className={PICKER_SEARCH_INPUT_CLASS}
      />
    </div>
    {actions}
  </div>
);
