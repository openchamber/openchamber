import React from 'react';
import { RowMarkTooltip } from './RowMarkTooltip';
import { Icon } from '@/components/icon/Icon';
import { cn, formatDirectoryName } from '@/lib/utils';
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useZoneProjectNames } from './useZoneProjectNames';

type TimelineRowProject = {
  id: string;
  label?: string | null;
  path?: string | null;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type Props = {
  compact?: boolean;
  project: TimelineRowProject | null;
  projectLabel: string | null;
  title: React.ReactNode;
  titleClassName: string;
  branchLabel: string | null;
  spaceMark?: string | null;
  metaLineLead?: React.ReactNode;
  leadToggle?: React.ReactNode;
  leadIconClassName?: string;
  leadMaskClassName?: string;
  leadIcon?: React.ReactNode;
  statusDot: React.ReactNode;
  pinnedMarker: React.ReactNode;
  timeSlot: React.ReactNode;
  directoryIndicator: React.ReactNode;
  prBadge: React.ReactNode;
  zombieIndicator: React.ReactNode;
  goal?: React.ReactNode;
  marks?: React.ReactNode;
  badges: React.ReactNode;
  doneHint?: React.ReactNode;
  metaPaddingClass?: string;
  hideMetaOnHoverClass: string;
  actionsReserveClass?: string;
  actionsMaskClass?: string;
};

const ProjectImageIcon: React.FC<{ project: TimelineRowProject; fallback: React.ReactNode }> = ({ project, fallback }) => {
  const { currentTheme } = useThemeSystem();
  return <ProjectIconImage
    project={{ id: project.id, iconImage: project.iconImage ?? null }}
    options={{ themeVariant: currentTheme.metadata.variant, iconColor: currentTheme.colors.surface.foreground }}
    className="h-full w-full object-contain"
    fallback={fallback}
  />;
};

export const TimelineProjectIcon: React.FC<{ project: TimelineRowProject; label: string | null }> = ({ project, label }) => {
  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = resolveProjectColor(project.color);
  const glyph = iconName
    ? <Icon name={iconName} className={cn('h-3 w-3', !iconColor && 'text-muted-foreground')} style={iconColor ? { color: iconColor } : undefined} />
    : <Icon name="folder" className="h-3 w-3 text-muted-foreground" style={iconColor ? { color: iconColor } : undefined} />;
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

const WHOLE_PROJECT_NAME_LENGTH = 8;

export const TimelineProjectName: React.FC<{ project: TimelineRowProject; fallback?: string | null; separated: boolean }> = ({ project, fallback = null, separated }) => {
  const name = project.label?.trim() || (project.path ? formatDirectoryName(project.path, null) : null) || fallback;
  if (!name) return null;
  return <>
    <span
      dir="auto"
      className={cn('truncate typography-micro text-muted-foreground', name.length > WHOLE_PROJECT_NAME_LENGTH ? 'min-w-16 shrink-[999]' : 'shrink-0')}
    >
      {name}
    </span>
    {separated ? <span aria-hidden="true" className="flex-shrink-0 typography-micro text-muted-foreground/50">·</span> : null}
  </>;
};

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
  leadMaskClassName,
  leadIcon: leadIconOverride = null,
  statusDot,
  pinnedMarker,
  timeSlot,
  directoryIndicator,
  prBadge,
  zombieIndicator,
  goal = null,
  marks = null,
  badges,
  doneHint = null,
  metaPaddingClass,
  hideMetaOnHoverClass,
  actionsReserveClass,
  actionsMaskClass,
}) => {
  const meta = (withMarks: boolean) => <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1', metaPaddingClass, hideMetaOnHoverClass)}>
    {doneHint}
    {compact ? goal : null}
    {compact ? zombieIndicator ?? prBadge : null}
    {withMarks ? marks : null}
    {compact ? badges : null}
    {directoryIndicator}
    {pinnedMarker}
    {statusDot}
    {timeSlot ? <span className="typography-micro leading-none text-muted-foreground tabular-nums">{timeSlot}</span> : null}
  </span>;
  const spaceIcon = spaceMark
    ? <Icon name="instance" className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden={false} role="img" aria-label={spaceMark} />
    : null;
  const projectNamed = useZoneProjectNames() && Boolean(project);
  const leadIcon = project
    ? <TimelineProjectIcon project={project} label={projectNamed ? null : projectLabel} />
    : leadIconOverride ?? (!metaLineLead && branchLabel ? spaceIcon : null);
  const maskedLead = Boolean(leadToggle && !leadIcon && leadMaskClassName);
  const branchText = (
    <span className={cn('min-w-0 truncate typography-micro text-muted-foreground', maskedLead && leadMaskClassName)}>{branchLabel}</span>
  );
  const branchLine = metaLineLead ?? (branchLabel ? <>{project ? spaceIcon : null}{branchText}</> : null);
  const leadSlot = leadToggle && (leadIcon || !maskedLead) ? (
    <span className="relative inline-flex size-3 flex-shrink-0 items-center justify-center">
      {leadIcon ? <span className={cn('inline-flex', leadIconClassName)}>{leadIcon}</span> : null}
      {leadToggle}
    </span>
  ) : maskedLead ? (
    <span className="absolute inset-y-0 start-0 z-10 inline-flex w-3 items-center justify-center">{leadToggle}</span>
  ) : leadIcon;
  const titleLine = (
    <div dir="auto" className={cn('oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label font-normal', actionsMaskClass, titleClassName)}>{title}</div>
  );
  if (compact) {
    return <div className={cn('@container relative flex w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {meta(true)}
    </div>;
  }
  const secondLine = Boolean(leadToggle || leadIcon || branchLine || goal || zombieIndicator || prBadge || badges);
  return <div className="flex w-full min-w-0 flex-col gap-px">
    <div className={cn('@container relative flex h-5 w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {meta(!secondLine)}
    </div>
    {secondLine ? <div className="relative flex h-4 w-full min-w-0 items-center gap-1">
      {leadSlot}
      {project && projectNamed ? <TimelineProjectName project={project} fallback={projectLabel} separated={Boolean(branchLine) && !metaLineLead && !spaceIcon} /> : null}
      {project ? branchLine : metaLineLead ?? (branchLabel ? branchText : null)}
      <span className="ms-auto flex flex-shrink-0 items-center gap-1">
        {goal}
        {zombieIndicator ?? prBadge}
        {marks}
        {badges}
      </span>
    </div> : null}
  </div>;
};
