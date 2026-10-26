import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import type { IconName } from '@/components/icon/icons';
import { WorkStatusTouchContext } from './touchContext';

/**
 * Row/section vocabulary for the work-status panel.
 *
 * Every readout is a labelled row — icon, name, trailing value — so a glance
 * answers "what is this number" without hovering. Sections carry a heading and
 * are separated by space alone; the panel itself stays chrome-less, since it is
 * an object inside the chat rather than a docked pane.
 *
 * On the phone's Status tab (`WorkStatusTouchContext`) the same vocabulary
 * takes the phone's grouped look, the one its Usage popover has: a quiet
 * heading over a toned card per section, rows with a 20px icon column, muted
 * label and value on the end, text from the typography scale. Sections never
 * branch on it themselves.
 */

/**
 * Sections are direct siblings inside the panel (fragments add no DOM nodes),
 * so the separator is a first-child CSS rule. Passing "am I first?" down as a
 * prop would mean every group tracking what the groups above it decided to
 * render.
 */
const SECTION_CLASS = cn(
  'flex flex-col',
  '[&:not(:first-child)]:mt-5',
);

const HEADING_CLASS = 'text-xs font-semibold text-foreground';
const TOUCH_HEADING_CLASS = 'typography-meta font-semibold text-muted-foreground';
const SUMMARY_CLASS = 'min-w-0 max-w-[60%] truncate text-end text-muted-foreground tabular-nums';

/** A section's rows on the phone: one toned card, a tone step from the page, no border. */
const TouchCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-col rounded-xl bg-foreground/[0.03] py-0.5">{children}</div>
);

export const WorkStatusSection: React.FC<{
  title: string;
  /** Names what the section is about, right after the title (the project). */
  subject?: React.ReactNode;
  /** Aggregate for the whole section; belongs on the heading, not on a row. */
  summary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subject, summary, children }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    <section className={SECTION_CLASS}>
      <div data-work-status-heading className={cn('flex items-center gap-2', touch ? 'mb-1.5 min-h-6 px-2.5' : 'mb-0.5 px-1')}>
        <h3 className={cn(touch ? TOUCH_HEADING_CLASS : HEADING_CLASS, 'min-w-0 flex-1 truncate')}>
          {title}
          {subject ? <span className="ms-1.5 font-normal text-muted-foreground">{subject}</span> : null}
        </h3>
        {summary !== undefined && summary !== null ? (
          <span dir="auto" className={cn(SUMMARY_CLASS, touch ? 'typography-meta' : 'text-xs')}>{summary}</span>
        ) : null}
      </div>
      {touch ? <TouchCard>{children}</TouchCard> : children}
    </section>
  );
};

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
  /** Keeps compact actions beside the title; wider action groups sit below it. */
  actionLayout?: 'inline' | 'below';
  defaultExpanded?: boolean;
  /** Optional preview that stays below the heading while the section is folded. */
  collapsedContent?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, icon, iconNode, iconColor, summary, action, actionLayout = 'inline', defaultExpanded = false, collapsedContent, children }) => {
  const stored = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections[id], [id]),
  );
  const setExpandedInStore = useUIStore((state) => state.setWorkStatusSectionExpanded);
  const touch = React.useContext(WorkStatusTouchContext);
  const expanded = stored ?? defaultExpanded;
  return (
    <section data-work-status-section={id} className={SECTION_CLASS}>
      <div data-work-status-heading className={cn('flex items-center gap-1', touch ? 'mb-1.5 min-h-9 ps-2.5' : 'mb-0.5', actionLayout === 'inline' && !touch && 'h-6')}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpandedInStore(id, !expanded)}
          className={cn(
            'group/section flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-start',
            // On the phone the whole heading is the tap target, as tall as a finger needs.
            touch ? 'min-h-9' : 'px-1',
            // No hover fill anywhere in the panel: at this row density the blocks
            // of colour read as selection, not as affordance. Interactivity shows
            // through the text instead.
            'transition-colors hover:text-foreground',
          )}
        >
          {iconNode ?? (icon ? (
            <Icon
              name={icon}
              className={cn('size-3.5 shrink-0', !iconColor && 'text-muted-foreground')}
              style={iconColor ? { color: iconColor } : undefined}
            />
          ) : null)}
          <span className={cn(touch ? TOUCH_HEADING_CLASS : HEADING_CLASS, 'min-w-0 truncate')}>{title}</span>
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex-1" />
          {summary !== undefined && summary !== null ? (
            <span dir="auto" className={cn(SUMMARY_CLASS, touch ? 'typography-meta pe-2.5' : 'text-xs')}>{summary}</span>
          ) : null}
        </button>
        {actionLayout === 'inline' ? action : null}
      </div>
      {actionLayout === 'below' ? action : null}
      {touch ? (
        expanded ? <TouchCard>{children}</TouchCard> : collapsedContent ? <TouchCard>{collapsedContent}</TouchCard> : null
      ) : (expanded ? children : collapsedContent)}
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
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
  tooltip?: React.ReactNode;
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
  tooltip,
  className,
}) => {
  const labelId = React.useId();
  const touch = React.useContext(WorkStatusTouchContext);
  const leadingNode = leading ?? (icon ? (
    <Icon
      name={icon}
      className={cn('size-3.5 shrink-0', !iconColor && 'text-muted-foreground')}
      style={iconColor ? { color: iconColor } : undefined}
    />
  ) : null);
  const body = (
    <>
      {touch && leadingNode ? (
        // The phone's icon column: 20px wide, every glyph in it at 16px, so
        // the status glyphs sections centre in a 14px slot line up as well.
        <span className="flex size-5 shrink-0 items-center justify-center [&>span]:size-5 [&_svg]:size-4">{leadingNode}</span>
      ) : leadingNode}
      <span id={labelId} className={cn('min-w-0 flex-1 truncate', touch ? 'typography-ui-label' : 'text-[0.8125rem]', muted && 'text-muted-foreground')}>
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span className={cn('flex shrink-0 items-center gap-1.5 tabular-nums', touch ? 'typography-ui-label font-medium text-foreground' : 'text-[0.8125rem]')}>{value}</span>
      ) : null}
    </>
  );

  const shared = cn(
    'flex w-full items-center text-start text-muted-foreground',
    touch ? 'min-h-11 gap-3 rounded-xl px-2.5' : 'h-7 gap-2 rounded-md px-1',
    className,
  );

  // A button cannot hold another one, and rows often carry their own (unpin,
  // a row action). The row's button is stretched under the content instead:
  // the whole row still answers a press, and controls inside it sit above.
  const row = onClick ? (
    <div className={cn(shared, 'oc-ref-tint-scope relative transition-colors hover:text-foreground')}>
      <button
        type="button"
        onClick={onClick}
        // The label no longer sits inside the button, so it names it here.
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelId}
        className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
      />
      <div className={cn('pointer-events-none relative flex min-w-0 flex-1 items-center [&_a]:pointer-events-auto [&_button]:pointer-events-auto', touch ? 'gap-3' : 'gap-2')}>
        {body}
      </div>
    </div>
  ) : <div className={shared} tabIndex={tooltip ? 0 : undefined}>{body}</div>;

  if (!tooltip) return row;

  return (
    // Above the row, as on every dense row, so it never covers the rows
    // under it or the actions beside it.
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-[min(320px,calc(100vw-24px))] whitespace-normal break-words text-start">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

const PILL_CLASS = 'px-1.5 py-px text-[0.6875rem] leading-4';
const PILL_TOUCH_CLASS = 'px-2 py-0.5 typography-micro';

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
  // Values are mostly numbers with units ("~41 tok/s", "6.6K ↑ · 242 ↓"); dir=auto
  // keeps those in their own order inside a right-to-left panel.
  <span
    dir="auto"
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
  const touch = React.useContext(WorkStatusTouchContext);
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
        'shrink-0 rounded-full font-medium transition-opacity',
        touch ? PILL_TOUCH_CLASS : PILL_CLASS,
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
}> = ({ children, color, background }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    <span
      className={cn(
        'rounded-full font-medium',
        touch ? PILL_TOUCH_CLASS : PILL_CLASS,
        !color && 'bg-[var(--interactive-hover)] text-muted-foreground',
      )}
      style={color ? { color, backgroundColor: background } : undefined}
    >
      {children}
    </span>
  );
};

/** Full-width callout for states that block the branch (merge, rebase, …). */
export const WorkStatusCallout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    <div
      className={cn(
        'flex items-center gap-2 font-medium',
        touch ? 'mx-1.5 my-1 rounded-lg px-2.5 py-2 typography-ui-label' : 'mx-1 mb-1 rounded-md px-2 py-1.5 text-[0.8125rem]',
      )}
      style={{ backgroundColor: 'var(--status-warning-background)', color: 'var(--status-warning)' }}
    >
      <Icon name="alert" className={cn('shrink-0', touch ? 'size-4' : 'size-3.5')} />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
};

/** Context-window fill, drawn under its row rather than inside it. */
export const WorkStatusMeter: React.FC<{ percent: number; color: string }> = ({ percent, color }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    // On the phone it starts under the row's label, past the icon column.
    <div className={cn('h-1 overflow-hidden rounded-full bg-[var(--chat-divider)]', touch ? 'mb-2 ms-[2.625rem] me-2.5' : 'mx-1 mb-1')}>
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
};

/**
 * A line explaining the readout above it (a cost split, a compaction note):
 * no icon and no label column, since it reports nothing of its own.
 */
export const WorkStatusNote: React.FC<{ children: React.ReactNode; truncate?: boolean }> = ({ children, truncate }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    <p
      className={cn(
        'text-muted-foreground tabular-nums',
        touch ? 'mb-2 ms-[2.625rem] me-2.5 typography-meta' : 'mx-1 mb-1 text-[0.6875rem] leading-4',
        truncate && 'truncate',
      )}
    >
      {children}
    </p>
  );
};
