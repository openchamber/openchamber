import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { cn } from '@/lib/utils';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';

type TimelineRowProject = {
  id: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type Props = {
  /** Chats rows inside the timeline: title and meta on one line, no project
      or branch lines. */
  compact?: boolean;
  project: TimelineRowProject | null;
  projectLabel: string | null;
  title: React.ReactNode;
  titleClassName: string;
  branchLabel: string | null;
  /** Set when the branch label is an isolated space's name: the third line
      then carries the space's container mark, with this as its accessible
      name, where a branch shows the branch icon. */
  spaceMark?: string | null;
  /** Replaces the branch at the start of the third line (a run row puts its
      mark and lane count there). */
  thirdLineLead?: React.ReactNode;
  statusDot: React.ReactNode;
  /** Pin glyph shown in the meta cluster while the row is pinned. */
  pinnedMarker: React.ReactNode;
  /** Elapsed-turn counter while running/unread, otherwise the compact date. */
  timeSlot: React.ReactNode;
  directoryIndicator: React.ReactNode;
  prBadge: React.ReactNode;
  zombieIndicator: React.ReactNode;
  /** Goal status glyph; opens the third line's state cluster, so it stays
      visible while a turn runs and while the hover actions cover line one. */
  goal?: React.ReactNode;
  badges: React.ReactNode;
  /** Jev's "looks done" check: it sits in the time cluster, where the hover
      Done action appears, left of the status dot so the dot stays by the time. */
  doneHint?: React.ReactNode;
  /** Provider of the session's model; its logo closes the third line. */
  providerId?: string | null;
  /** Reserves room for permanently shown action buttons on the first line. */
  metaPaddingClass?: string;
  hideMetaOnHoverClass: string;
  /** Sets how far hover-revealed actions reach into the first line
      (`--oc-actions-reserve`). */
  actionsReserveClass?: string;
  /** Fades the first line's text away under hover-revealed actions. */
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

const TimelineProjectIcon: React.FC<{ project: TimelineRowProject | null }> = ({ project }) => {
  const iconName = project?.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project?.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;
  const glyph = iconName
    ? <Icon name={iconName} className={cn('h-3.5 w-3.5', !iconColor && 'text-muted-foreground/75')} style={iconColor ? { color: iconColor } : undefined} />
    : <Icon name="folder" className="h-3.5 w-3.5 text-muted-foreground/75" style={iconColor ? { color: iconColor } : undefined} />;
  if (!project?.iconImage) {
    return <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">{glyph}</span>;
  }
  return <span
    className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
    style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
  >
    <ProjectImageIcon project={project} fallback={glyph} />
  </span>;
};

// Timeline rows carry their own context, because the list has no project,
// worktree or folder headers above them: project on the first line, the title
// on the second, branch and pull-request state on the third.
export const SessionTimelineRowBody: React.FC<Props> = ({
  compact = false,
  project,
  projectLabel,
  title,
  titleClassName,
  branchLabel,
  spaceMark = null,
  thirdLineLead = null,
  statusDot,
  pinnedMarker,
  timeSlot,
  directoryIndicator,
  prBadge,
  zombieIndicator,
  goal = null,
  badges,
  doneHint = null,
  providerId,
  metaPaddingClass,
  hideMetaOnHoverClass,
  actionsReserveClass,
  actionsMaskClass,
}) => {
  const hasThirdLine = !compact && (Boolean(branchLabel) || Boolean(thirdLineLead) || Boolean(prBadge) || Boolean(zombieIndicator) || Boolean(goal) || Boolean(badges) || Boolean(providerId));
  // Compact rows have no third line, so their badges ride in the meta
  // cluster: the hover actions overlay that cluster, and anything placed
  // after it would sit underneath them.
  const meta = <span className={cn('ml-auto flex flex-shrink-0 items-center gap-1 transition-opacity', metaPaddingClass, hideMetaOnHoverClass)}>
    {compact ? goal : null}
    {compact ? badges : null}
    {directoryIndicator}
    {pinnedMarker}
    {doneHint}
    {statusDot}
    <span className="typography-micro leading-none text-muted-foreground/50 tabular-nums">{timeSlot}</span>
  </span>;
  if (compact) {
    return <div className={cn('@container relative flex w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      <div dir="auto" className={cn('min-w-0 flex-1 truncate typography-ui-label font-normal', actionsMaskClass, titleClassName)}>{title}</div>
      {meta}
    </div>;
  }
  return <div className="flex w-full min-w-0 flex-col gap-px">
    {/* Fixed 20px first line: the hover actions are positioned against the
        row from outside and rely on this height to sit exactly on it. */}
    <div className={cn('@container relative flex h-5 w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      <TimelineProjectIcon project={project} />
      {projectLabel ? (
        // Starts past the 14px project icon and the 4px gap.
        <span className={cn('min-w-0 truncate typography-micro text-muted-foreground/85 [--oc-actions-inset:18px]', actionsMaskClass)}>{projectLabel}</span>
      ) : null}
      {meta}
    </div>
    <div dir="auto" className={cn('w-full min-w-0 truncate typography-ui-label font-normal', titleClassName)}>{title}</div>
    {hasThirdLine ? (
      <div className="flex w-full min-w-0 items-center gap-1">
        {thirdLineLead ?? (branchLabel ? (
          <>
            {spaceMark
              // `Icon` hides itself from assistive tech; the space's mark is the row's only word for "space", so it speaks.
              ? <Icon name="box-3" className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" aria-hidden={false} role="img" aria-label={spaceMark} />
              : <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />}
            <span className="min-w-0 truncate typography-micro text-muted-foreground/50">{branchLabel}</span>
          </>
        ) : null)}
        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          {goal}
          {zombieIndicator ?? prBadge}
          {badges}
          {providerId ? <ProviderLogo providerId={providerId} className="h-4 w-4 flex-shrink-0 opacity-45" /> : null}
        </span>
      </div>
    ) : null}
  </div>;
};
