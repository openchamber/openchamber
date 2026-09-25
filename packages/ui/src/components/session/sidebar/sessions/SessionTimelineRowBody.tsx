import React from 'react';
import { Icon } from '@/components/icon/Icon';
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
  statusDot: React.ReactNode;
  /** Pin glyph shown in the meta cluster while the row is pinned. */
  pinnedMarker: React.ReactNode;
  /** Elapsed-turn counter while running/unread, otherwise the compact date. */
  timeSlot: React.ReactNode;
  directoryIndicator: React.ReactNode;
  prBadge: React.ReactNode;
  zombieIndicator: React.ReactNode;
  badges: React.ReactNode;
  /** Reserves room for the action buttons that share the first line. */
  metaPaddingClass?: string;
  hideMetaOnHoverClass: string;
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
  statusDot,
  pinnedMarker,
  timeSlot,
  directoryIndicator,
  prBadge,
  zombieIndicator,
  badges,
  metaPaddingClass,
  hideMetaOnHoverClass,
}) => {
  const hasThirdLine = !compact && (Boolean(branchLabel) || Boolean(prBadge) || Boolean(zombieIndicator) || Boolean(badges));
  // Compact rows have no third line, so their badges ride in the meta
  // cluster: the hover actions overlay that cluster, and anything placed
  // after it would sit underneath them.
  const meta = <span className={cn('ml-auto flex flex-shrink-0 items-center gap-1 transition-opacity', metaPaddingClass, hideMetaOnHoverClass)}>
    {compact ? badges : null}
    {directoryIndicator}
    {pinnedMarker}
    {statusDot}
    <span className="typography-micro leading-none text-muted-foreground/50 tabular-nums">{timeSlot}</span>
  </span>;
  if (compact) {
    return <div className="relative flex w-full min-w-0 items-center gap-1">
      <div className={cn('min-w-0 flex-1 truncate typography-ui-label font-normal', titleClassName)}>{title}</div>
      {meta}
    </div>;
  }
  return <div className="flex w-full min-w-0 flex-col gap-px">
    {/* Fixed 20px first line: the hover actions are positioned against the
        row from outside and rely on this height to sit exactly on it. */}
    <div className="relative flex h-5 w-full min-w-0 items-center gap-1">
      <TimelineProjectIcon project={project} />
      {projectLabel ? (
        <span className="min-w-0 truncate typography-micro text-muted-foreground/85">{projectLabel}</span>
      ) : null}
      {meta}
    </div>
    <div className={cn('w-full min-w-0 truncate typography-ui-label font-normal', titleClassName)}>{title}</div>
    {hasThirdLine ? (
      <div className="flex w-full min-w-0 items-center gap-1">
        {branchLabel ? (
          <>
            <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
            <span className="min-w-0 truncate typography-micro text-muted-foreground/50">{branchLabel}</span>
          </>
        ) : null}
        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          {zombieIndicator ?? prBadge}
          {badges}
        </span>
      </div>
    ) : null}
  </div>;
};
