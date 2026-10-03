import React from 'react';
import { RiFolder6Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';

/** The project fields the icon needs — a structural subset of the sheet's
    ProjectMeta, so both the sheet and the timeline list can pass their own
    project objects without sharing a type. */
export type MobileProjectIconProject = {
  id: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

export const MobileProjectIcon: React.FC<{
  project: MobileProjectIconProject;
  size?: 'sm' | 'md';
}> = ({ project, size = 'md' }) => {
  const { currentTheme } = useThemeSystem();

  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] ?? null : null;

  const containerClasses = size === 'sm' ? 'size-6 rounded-md' : 'size-8 rounded-lg';
  const innerClasses = size === 'sm' ? 'size-3.5' : 'size-4';
  const fallbackIcon = ProjectIcon ? (
    <Icon name={ProjectIcon} className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  ) : (
    <RiFolder6Line className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  );

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground',
        // The small variant sits inline in a text line and needs no tile.
        size === 'md' && 'bg-[var(--surface-muted)]',
        containerClasses,
      )}
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
    >
      {project.iconImage ? (
        <ProjectIconImage
          project={{ id: project.id, iconImage: project.iconImage ?? null }}
          options={{
            themeVariant: currentTheme.metadata.variant,
            iconColor: currentTheme.colors.surface.foreground,
          }}
          className="size-full object-contain"
          fallback={fallbackIcon}
        />
      ) : fallbackIcon}
    </span>
  );
};
