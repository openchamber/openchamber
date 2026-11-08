import React from 'react';
import { RowMarkTooltip } from './RowMarkTooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';

type TimelineRowProject = {
  id: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type Props = {
  /** One-line rows (tree rows, Chats, Pinned, In work and the list by time):
      title and meta on one line, no branch line. */
  compact?: boolean;
  /** Set on detailed rows where projects mix (Pinned, In work, the list by
      time): the second line opens with this project's icon. One-line rows
      leave that room to the title.
      Rows under their project header pass null. */
  project: TimelineRowProject | null;
  /** The project's name, spoken and shown on hover for its icon. */
  projectLabel: string | null;
  title: React.ReactNode;
  titleClassName: string;
  branchLabel: string | null;
  /** Set when the branch label is an isolated space's name: the second line
      then carries the space's container mark, with this as its accessible
      name, where a branch shows the branch icon. */
  spaceMark?: string | null;
  /** Replaces the branch on the second line (a run row puts its mark and
      lane count there). */
  metaLineLead?: React.ReactNode;
  /** The chevron of a row with something nested under it: it takes the place
      of the second line's first icon (the project's, else the branch's or the
      space's) while the row is hovered, so a two-line row needs no column of
      its own for it. It positions itself over that icon (`absolute inset-0`)
      and shows on hover; `leadIconClassName` hides the icon in step. */
  leadToggle?: React.ReactNode;
  leadIconClassName?: string;
  /** The second line's first icon where no project opens it, in place of the
      branch's: a run's mark, which has no branch. */
  leadIcon?: React.ReactNode;
  statusDot: React.ReactNode;
  /** Pin glyph shown in the meta cluster while the row is pinned. */
  pinnedMarker: React.ReactNode;
  /** The turn's duration while it runs and until it is read; no date otherwise
      (the list is ordered by recency, the row's tooltip has the time). */
  timeSlot: React.ReactNode;
  directoryIndicator: React.ReactNode;
  prBadge: React.ReactNode;
  zombieIndicator: React.ReactNode;
  /** Goal status glyph; opens the second line's state cluster, so it stays
      visible while a turn runs and while the hover actions cover line one. */
  goal?: React.ReactNode;
  badges: React.ReactNode;
  /** Jev's "looks done" check: it sits in the time cluster, where the hover
      Done action appears, left of the status dot so the dot stays by the time. */
  doneHint?: React.ReactNode;
  /** Reserves room for permanently shown action buttons on the title line. */
  metaPaddingClass?: string;
  hideMetaOnHoverClass: string;
  /** Sets how far hover-revealed actions reach into the title line
      (`--oc-actions-reserve`). */
  actionsReserveClass?: string;
  /** Fades the title's tail away under hover-revealed actions. */
  actionsMaskClass?: string;
};

// Only rows whose project carries a custom image pay for the theme
// subscription the image resolution needs.
const ProjectImageIcon: React.FC<{ project: TimelineRowProject; fallback: React.ReactNode }> = ({ project, fallback }) => {
  const { currentTheme } = useThemeSystem();
  return <ProjectIconImage
    project={{ id: project.id, iconImage: project.iconImage ?? null }}
    options={{ themeVariant: currentTheme.metadata.variant, iconColor: currentTheme.colors.surface.foreground }}
    className="h-full w-full object-contain"
    fallback={fallback}
  />;
};

// `label` makes the icon speak and explain itself on hover, for rows where it
// is the only word for the project; a row that prints the name passes null.
export const TimelineProjectIcon: React.FC<{ project: TimelineRowProject; label: string | null }> = ({ project, label }) => {
  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = resolveProjectColor(project.color);
  const glyph = iconName
    ? <Icon name={iconName} className={cn('h-3 w-3', !iconColor && 'text-muted-foreground')} style={iconColor ? { color: iconColor } : undefined} />
    : <Icon name="folder" className="h-3 w-3 text-muted-foreground" style={iconColor ? { color: iconColor } : undefined} />;
  // The icon is the row's only word for its project, so it speaks.
  const labelProps = label ? { role: 'img', 'aria-label': label } : {};
  const mark = project.iconImage
    ? <span
      className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
      {...labelProps}
    >
      <ProjectImageIcon project={project} fallback={glyph} />
    </span>
    : <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center" {...labelProps}>{glyph}</span>;
  return label ? <RowMarkTooltip label={label}>{mark}</RowMarkTooltip> : mark;
};

// One line: the title with the session's live state. Two lines (the detailed
// zone rows): then the branch and pull-request state, opened by the project's
// icon where projects mix.
export const SessionTimelineRowBody: React.FC<Props> = ({
  compact = false,
  project,
  projectLabel,
  title,
  titleClassName,
  branchLabel,
  spaceMark = null,
  metaLineLead = null,
  leadToggle = null,
  leadIconClassName,
  leadIcon: leadIconOverride = null,
  statusDot,
  pinnedMarker,
  timeSlot,
  directoryIndicator,
  prBadge,
  zombieIndicator,
  goal = null,
  badges,
  doneHint = null,
  metaPaddingClass,
  hideMetaOnHoverClass,
  actionsReserveClass,
  actionsMaskClass,
}) => {
  // Compact rows have no second line, so their badges ride in the meta
  // cluster: the hover actions overlay that cluster, and anything placed
  // after it would sit underneath them.
  const meta = <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1', metaPaddingClass, hideMetaOnHoverClass)}>
    {compact ? goal : null}
    {compact ? zombieIndicator ?? prBadge : null}
    {compact ? badges : null}
    {directoryIndicator}
    {pinnedMarker}
    {doneHint}
    {statusDot}
    {timeSlot ? <span className="typography-micro leading-none text-muted-foreground tabular-nums">{timeSlot}</span> : null}
  </span>;
  // The second line's first icon: the project's where projects mix, else the
  // branch's (or the space's) in front of its name.
  const branchIcon = spaceMark
    // `Icon` hides itself from assistive tech; the space's mark is the row's only word for "space", so it speaks.
    ? <Icon name="instance" className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden={false} role="img" aria-label={spaceMark} />
    : <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />;
  const branchText = <span className="min-w-0 truncate typography-micro text-muted-foreground">{branchLabel}</span>;
  const branchLine = metaLineLead ?? (branchLabel ? <>{branchIcon}{branchText}</> : null);
  const leadIcon = project
    ? <TimelineProjectIcon project={project} label={projectLabel} />
    : leadIconOverride ?? (!metaLineLead && branchLabel ? branchIcon : null);
  const titleLine = (
    <div dir="auto" className={cn('oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label font-normal', actionsMaskClass, titleClassName)}>{title}</div>
  );
  if (compact) {
    return <div className={cn('@container relative flex w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {meta}
    </div>;
  }
  return <div className="flex w-full min-w-0 flex-col gap-px">
    {/* Fixed 20px first line: the hover actions are positioned against the
        row from outside and rely on this height to sit exactly on it. */}
    <div className={cn('@container relative flex h-5 w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {meta}
    </div>
    {leadToggle || leadIcon || branchLine || goal || zombieIndicator || prBadge || badges ? <div className="flex h-4 w-full min-w-0 items-center gap-1">
      {leadToggle ? (
        <span className="relative inline-flex size-3 flex-shrink-0 items-center justify-center">
          {leadIcon ? <span className={cn('inline-flex', leadIconClassName)}>{leadIcon}</span> : null}
          {leadToggle}
        </span>
      ) : leadIcon}
      {project ? branchLine : metaLineLead ?? (branchLabel ? branchText : null)}
      <span className="ms-auto flex flex-shrink-0 items-center gap-1">
        {goal}
        {zombieIndicator ?? prBadge}
        {badges}
      </span>
    </div> : null}
  </div>;
};
