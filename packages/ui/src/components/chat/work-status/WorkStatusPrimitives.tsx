import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import type { IconName } from '@/components/icon/icons';
import { WorkStatusTouchContext } from './touchContext';


const SECTION_CLASS = cn(
  'flex flex-col',
  '[&:not(:first-child)]:mt-5',
);

const HEADING_CLASS = 'text-[0.8125rem] font-medium text-foreground';
const TOUCH_HEADING_CLASS = 'typography-meta font-semibold text-muted-foreground';
const SUMMARY_CLASS = 'min-w-0 max-w-[60%] truncate text-end tabular-nums';
const SUMMARY_DESKTOP_CLASS = 'text-[0.8125rem] text-foreground';
const SUMMARY_TOUCH_CLASS = 'typography-meta text-muted-foreground';

const TouchCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-col rounded-xl bg-foreground/[0.03] py-0.5">{children}</div>
);

export const WorkStatusSection: React.FC<{
  title: string;
  icon: IconName;
  subject?: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, subject, summary, children }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  const trailing = summary ?? subject;
  return (
    <section className={SECTION_CLASS}>
      <div data-work-status-heading className={cn('flex items-center gap-2', touch ? 'mb-1.5 min-h-6 px-2.5' : 'mb-0.5 h-6 px-1')}>
        {touch ? null : <Icon name={icon} className="size-[13px] shrink-0 text-muted-foreground" />}
        <h3 className={cn(touch ? TOUCH_HEADING_CLASS : HEADING_CLASS, 'min-w-0 flex-1 truncate')}>
          {title}
        </h3>
        {trailing !== undefined && trailing !== null ? (
          <span dir="auto" className={cn(SUMMARY_CLASS, touch ? SUMMARY_TOUCH_CLASS : SUMMARY_DESKTOP_CLASS)}>{trailing}</span>
        ) : null}
      </div>
      {touch ? <TouchCard>{children}</TouchCard> : children}
    </section>
  );
};

export const WorkStatusCollapsibleSection: React.FC<{
  id: string;
  title: string;
  icon?: IconName;
  iconNode?: React.ReactNode;
  iconColor?: string;
  summary?: React.ReactNode;
  titleAction?: React.ReactNode;
  action?: React.ReactNode;
  actionLayout?: 'inline' | 'below';
  defaultExpanded?: boolean;
  collapsedContent?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, icon, iconNode, iconColor, summary, titleAction, action, actionLayout = 'inline', defaultExpanded = false, collapsedContent, children }) => {
  const titleId = React.useId();
  const summaryId = React.useId();
  const stored = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections[id], [id]),
  );
  const setExpandedInStore = useUIStore((state) => state.setWorkStatusSectionExpanded);
  const touch = React.useContext(WorkStatusTouchContext);
  const expanded = stored ?? defaultExpanded;
  const hasSummary = summary !== undefined && summary !== null;
  return (
    <section data-work-status-section={id} className={SECTION_CLASS}>
      <div data-work-status-heading className={cn('flex items-center gap-1', touch ? 'mb-1.5 min-h-9 ps-2.5' : 'mb-0.5', actionLayout === 'inline' && !touch && 'h-6')}>
        <div className="group/section relative flex min-w-0 flex-1 items-center">
          <button
            type="button"
            aria-expanded={expanded}
            aria-labelledby={titleId}
            aria-describedby={hasSummary ? summaryId : undefined}
            onClick={() => setExpandedInStore(id, !expanded)}
            className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
          />
          <div
            className={cn(
              'pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 rounded-md text-start',
              touch ? 'min-h-9' : 'px-1',
              'transition-colors group-has-[>[aria-expanded]:hover]/section:text-foreground',
            )}
          >
            {touch ? (iconNode ?? (icon ? (
              <Icon
                name={icon}
                className={cn('size-3.5 shrink-0', !iconColor && 'text-muted-foreground')}
                style={iconColor ? { color: iconColor } : undefined}
              />
            ) : null)) : (
              <span className="relative inline-flex size-[13px] shrink-0 items-center justify-center">
                {iconNode || icon ? (
                  <span className={cn('inline-flex transition-opacity', expanded ? 'opacity-0' : 'group-has-[>[aria-expanded]:hover]/section:opacity-0 group-has-[>[aria-expanded]:focus-visible]/section:opacity-0')}>
                    {iconNode ?? (icon ? (
                      <Icon
                        name={icon}
                        className={cn('size-[13px] shrink-0', !iconColor && 'text-muted-foreground')}
                        style={iconColor ? { color: iconColor } : undefined}
                      />
                    ) : null)}
                  </span>
                ) : null}
                <Icon
                  name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
                  className={cn(
                    'absolute inset-0 size-[13px] text-muted-foreground transition-opacity rtl:-scale-x-100',
                    !(iconNode || icon) || expanded ? 'opacity-100' : 'opacity-0 group-has-[>[aria-expanded]:hover]/section:opacity-100 group-has-[>[aria-expanded]:focus-visible]/section:opacity-100',
                  )}
                />
              </span>
            )}
            <span id={titleId} className={cn(touch ? TOUCH_HEADING_CLASS : HEADING_CLASS, 'min-w-0 truncate transition-colors group-has-[>[aria-expanded]:hover]/section:text-foreground')}>{title}</span>
            {titleAction ? (
              <span className="pointer-events-auto -ms-1.5 inline-flex shrink-0 items-center">
                {titleAction}
              </span>
            ) : null}
            <span className="flex-1" />
            {hasSummary ? (
              <span id={summaryId} dir="auto" className={cn(SUMMARY_CLASS, touch ? SUMMARY_TOUCH_CLASS : SUMMARY_DESKTOP_CLASS)}>{summary}</span>
            ) : null}
            {touch ? (
              <Icon
                name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
                className="me-2.5 size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100"
              />
            ) : null}
          </div>
        </div>
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
  detail?: React.ReactNode;
  muted?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
  expanded?: boolean;
  tooltip?: React.ReactNode;
  className?: string;
  labelDir?: 'auto' | 'ltr';
};

export const WorkStatusRow: React.FC<RowProps> = ({
  icon,
  iconColor,
  leading,
  label,
  value,
  detail,
  muted,
  onClick,
  ariaLabel,
  expanded,
  tooltip,
  className,
  labelDir,
}) => {
  const labelId = React.useId();
  const touch = React.useContext(WorkStatusTouchContext);
  const twoLines = detail !== undefined && detail !== null;
  const leadingNode = leading ?? (icon ? (
    <Icon
      name={icon}
      className={cn('size-[13px] shrink-0', !iconColor && 'text-muted-foreground')}
      style={iconColor ? { color: iconColor } : undefined}
    />
  ) : null);
  const leadingSlot = touch && leadingNode ? (
    <span className="flex size-5 shrink-0 items-center justify-center [&>span]:size-5 [&_svg]:size-4">{leadingNode}</span>
  ) : leadingNode;
  const firstLine = (
    <>
      <span id={labelId} dir={labelDir} className={cn('min-w-0 flex-1 truncate', labelDir && 'oc-ui-start-align', touch ? 'typography-ui-label' : 'text-[0.8125rem]', muted && 'text-muted-foreground')}>
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span className={cn('flex shrink-0 items-center gap-1.5 tabular-nums text-foreground', touch ? 'typography-ui-label font-medium' : 'text-[0.8125rem]')}>{value}</span>
      ) : null}
    </>
  );
  const body = twoLines ? (
    <>
      {leadingSlot ? <span className={cn('flex shrink-0 items-center', touch ? 'h-6' : 'h-5')}>{leadingSlot}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('flex min-w-0 items-center', touch ? 'h-6 gap-3' : 'h-5 gap-2')}>{firstLine}</span>
        <span className={cn('min-w-0 truncate text-muted-foreground', touch ? 'typography-meta' : 'text-[0.6875rem] leading-4')}>{detail}</span>
      </span>
    </>
  ) : (
    <>
      {leadingSlot}
      {firstLine}
    </>
  );

  const shared = cn(
    'flex w-full text-start text-muted-foreground',
    twoLines ? 'items-start' : 'items-center',
    touch
      ? cn('min-h-11 gap-3 rounded-xl px-2.5', twoLines && 'py-1.5')
      : cn('gap-2 rounded-md px-1', twoLines ? 'py-[3px]' : 'h-[1.625rem]'),
    className,
  );

  const row = onClick ? (
    <div className={cn(shared, 'relative transition-colors hover:text-foreground')}>
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelId}
        aria-expanded={expanded}
        className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
      />
      <div className={cn('pointer-events-none relative flex min-w-0 flex-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto', twoLines ? 'items-start' : 'items-center', touch ? 'gap-3' : 'gap-2')}>
        {body}
      </div>
    </div>
  ) : <div className={shared} tabIndex={tooltip ? 0 : undefined}>{body}</div>;

  if (!tooltip) return row;

  return (
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
  <span
    dir="auto"
    className={tone === 'muted' ? 'text-muted-foreground' : undefined}
    style={tone === 'default' || tone === 'muted' ? undefined : { color: TONE_COLOR[tone] }}
  >
    {children}
  </span>
);

export const WorkStatusRowAction: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'warning' | 'error' | 'info';
  disabled?: boolean;
  ariaLabel?: string;
}> = ({ children, onClick, tone = 'default', disabled, ariaLabel }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  const color = tone === 'default' ? undefined : TONE_COLOR[tone];
  const button = (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(event) => {
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
  if (!ariaLabel) return button;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>{ariaLabel}</TooltipContent>
    </Tooltip>
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
      <Icon name="alert" className={cn('shrink-0', touch ? 'size-4' : 'size-[13px]')} />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
};

export const WorkStatusMeter: React.FC<{ percent: number; color: string }> = ({ percent, color }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] dark:bg-[color-mix(in_srgb,var(--foreground)_14%,transparent)]', touch ? 'mx-2.5 mb-2' : 'mx-1 mt-[3px] mb-[5px]')}>
      <div
        className={cn('h-full rounded-full', percent > 0 && 'min-w-1')}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
};

export const WorkStatusNote: React.FC<{ children: React.ReactNode; truncate?: boolean; tooltip?: string }> = ({ children, truncate, tooltip }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  const note = (
    <p
      className={cn(
        'text-muted-foreground tabular-nums',
        touch ? 'mb-2 ms-[2.625rem] me-2.5 typography-meta' : 'mx-1 mb-1 text-[0.6875rem] leading-4',
        (truncate || tooltip) && 'truncate',
      )}
      tabIndex={tooltip ? 0 : undefined}
    >
      {children}
    </p>
  );
  if (!tooltip) return note;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{note}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-[min(320px,calc(100vw-24px))] whitespace-normal break-words text-start">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};
