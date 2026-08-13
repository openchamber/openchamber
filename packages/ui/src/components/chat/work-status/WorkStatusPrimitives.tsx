import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import type { IconName } from '@/components/icon/icons';

/**
 * Row/section vocabulary for the work-status panel.
 *
 * Every readout is a labelled row — icon, name, trailing value — so a glance
 * answers "what is this number" without hovering. Sections carry a heading and
 * are separated by a hairline; the panel itself stays chrome-less, since it is
 * an object inside the chat rather than a docked pane.
 */

/**
 * Sections are direct siblings inside the panel (fragments add no DOM nodes),
 * so the separator is a first-child CSS rule. Passing "am I first?" down as a
 * prop would mean every group tracking what the groups above it decided to
 * render.
 */
const SECTION_CLASS = cn(
  'flex flex-col',
  '[&:not(:first-child)]:mt-3 [&:not(:first-child)]:border-t',
  '[&:not(:first-child)]:border-[var(--interactive-border)] [&:not(:first-child)]:pt-3',
);

const HEADING_CLASS = 'text-xs font-normal text-muted-foreground';

export const WorkStatusSection: React.FC<{
  title: string;
  /** Aggregate for the whole section; belongs on the heading, not on a row. */
  summary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, summary, children }) => (
  <section className={SECTION_CLASS}>
    <div className="mb-0.5 flex items-center gap-2 px-1">
      <h3 className={cn(HEADING_CLASS, 'min-w-0 flex-1 truncate')}>{title}</h3>
      {summary !== undefined && summary !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{summary}</span>
      ) : null}
    </div>
    {children}
  </section>
);

/**
 * Section whose body folds away. The chevron swaps on expand exactly as the
 * transcript's tool blocks do, so the two collapsibles read as the same
 * control rather than two conventions in one window.
 *
 * Expanded state lives in the persisted UI store, not in component state: the
 * panel unmounts whenever the context panel opens, and local state would
 * silently discard the user's arrangement every time.
 */
export const WorkStatusCollapsibleSection: React.FC<{
  /** Stable key for persisting expanded state. */
  id: string;
  title: string;
  icon?: IconName;
  /** For glyphs that live outside the sprite, such as the MCP mark. */
  iconNode?: React.ReactNode;
  iconColor?: string;
  /** Shown on the header while collapsed and expanded alike. */
  summary?: React.ReactNode;
  /** An independent header action, such as refreshing this section's data. */
  action?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}> = ({ id, title, icon, iconNode, iconColor, summary, action, defaultExpanded = false, children }) => {
  const stored = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections[id], [id]),
  );
  const setExpandedInStore = useUIStore((state) => state.setWorkStatusSectionExpanded);
  const expanded = stored ?? defaultExpanded;
  return (
    <section className={SECTION_CLASS}>
      <div className="mb-0.5 flex h-6 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpandedInStore(id, !expanded)}
          className={cn(
            'group/section flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left',
            // No hover fill anywhere in the panel: at this row density the blocks
            // of colour read as selection, not as affordance. Interactivity shows
            // through the text instead.
            'transition-colors hover:text-foreground',
          )}
        >
          {iconNode ?? (icon ? (
            <Icon
              name={icon}
              className={cn('size-4 shrink-0', !iconColor && 'text-muted-foreground')}
              style={iconColor ? { color: iconColor } : undefined}
            />
          ) : null)}
          <span className={cn(HEADING_CLASS, 'min-w-0 truncate')}>{title}</span>
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex-1" />
          {summary !== undefined && summary !== null ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{summary}</span>
          ) : null}
        </button>
        {action}
      </div>
      {expanded ? children : null}
    </section>
  );
};

type RowProps = {
  icon?: IconName;
  iconColor?: string;
  leading?: React.ReactNode;
  label: React.ReactNode;
  value?: React.ReactNode;
  muted?: boolean;
  /** Turns the row into a button; the caller decides what it opens. */
  onClick?: () => void;
  ariaLabel?: string;
  className?: string;
};

/**
 * A single readout. `value` sits hard right; `label` truncates before it, so a
 * long branch name never pushes its own ahead/behind counts out of view.
 */
export const WorkStatusRow: React.FC<RowProps> = ({
  icon,
  iconColor,
  leading,
  label,
  value,
  muted,
  onClick,
  ariaLabel,
  className,
}) => {
  const body = (
    <>
      {leading ?? (icon ? (
        <Icon
          name={icon}
          className={cn('size-4 shrink-0', !iconColor && 'text-muted-foreground')}
          style={iconColor ? { color: iconColor } : undefined}
        />
      ) : null)}
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', muted && 'text-muted-foreground')}>
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums">{value}</span>
      ) : null}
    </>
  );

  const shared = cn('flex h-7 w-full items-center gap-2 rounded-md px-1 text-left', className);

  if (!onClick) return <div className={shared}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(shared, 'transition-colors hover:text-foreground')}
    >
      {body}
    </button>
  );
};

type WorkStatusTone = 'default' | 'muted' | 'success' | 'error' | 'warning' | 'info';

const TONE_COLOR: Record<Exclude<WorkStatusTone, 'default' | 'muted'>, string> = {
  success: 'var(--status-success)',
  error: 'var(--status-error)',
  warning: 'var(--status-warning)',
  info: 'var(--status-info)',
};

export const WorkStatusValue: React.FC<{
  children: React.ReactNode;
  tone?: WorkStatusTone;
}> = ({ children, tone = 'default' }) => (
  <span
    className={tone === 'muted' ? 'text-muted-foreground' : undefined}
    style={tone === 'default' || tone === 'muted' ? undefined : { color: TONE_COLOR[tone] }}
  >
    {children}
  </span>
);

/**
 * Trailing control shaped like the PR badge: a status that is also the thing
 * you press. Used where the state itself is the affordance — an MCP server
 * asking for sign-in, a goal waiting to be resumed.
 */
export const WorkStatusRowAction: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'warning' | 'error' | 'info';
  disabled?: boolean;
  ariaLabel?: string;
}> = ({ children, onClick, tone = 'default', disabled, ariaLabel }) => {
  const color = tone === 'default' ? undefined : TONE_COLOR[tone];
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(event) => {
        // The row underneath is often a button of its own with a different
        // destination.
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 transition-opacity',
        'hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50',
        !color && 'bg-[var(--interactive-hover)] text-muted-foreground',
      )}
      style={color
        ? { color, backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }
        : undefined}
    >
      {children}
    </button>
  );
};

export const WorkStatusPill: React.FC<{
  children: React.ReactNode;
  color?: string;
  background?: string;
}> = ({ children, color, background }) => (
  <span
    className={cn(
      'rounded-full px-1.5 py-px text-[11px] font-medium leading-4',
      !color && 'bg-[var(--interactive-hover)] text-muted-foreground',
    )}
    style={color ? { color, backgroundColor: background } : undefined}
  >
    {children}
  </span>
);

/** Full-width callout for states that block the branch (merge, rebase, …). */
export const WorkStatusCallout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="mx-1 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium"
    style={{ backgroundColor: 'var(--status-warning-background)', color: 'var(--status-warning)' }}
  >
    <Icon name="alert" className="size-4 shrink-0" />
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

/** Context-window fill, drawn under its row rather than inside it. */
export const WorkStatusMeter: React.FC<{ percent: number; color: string }> = ({ percent, color }) => (
  <div className="mx-1 mb-1 h-1 overflow-hidden rounded-full bg-[var(--chat-divider)]">
    <div
      className="h-full rounded-full"
      style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
    />
  </div>
);
