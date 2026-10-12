import React from 'react';
import { RiFolder6Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';

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
  /** xs sits inside a 16px text line, md in a header's 32px slot. */
  size?: 'xs' | 'md';
}> = ({ project, size = 'md' }) => {
  const { currentTheme } = useThemeSystem();

  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] ?? null : null;

  const glyphClasses = size === 'md' ? 'size-5' : 'size-3.5';
  const fallbackIcon = ProjectIcon ? (
    <Icon name={ProjectIcon} className={glyphClasses} style={iconColor ? { color: iconColor } : undefined} />
  ) : (
    <RiFolder6Line className={glyphClasses} style={iconColor ? { color: iconColor } : undefined} />
  );
  const image = project.iconImage ? (
    <ProjectIconImage
      project={{ id: project.id, iconImage: project.iconImage ?? null }}
      options={{
        themeVariant: currentTheme.metadata.variant,
        iconColor: currentTheme.colors.surface.foreground,
      }}
      className="size-full object-contain"
      fallback={fallbackIcon}
    />
  ) : null;
  const imageBackground = project.iconBackground ? { backgroundColor: project.iconBackground } : undefined;

  if (size === 'md') {
    // A header's 32px slot, which the rows under it align to. No tile: a
    // glyph sits bare at 20px, and an image takes 24px with its own corners,
    // so both read at about the same weight next to the label.
    return (
      <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
        {image ? (
          <span className="flex size-6 items-center justify-center overflow-hidden rounded-md" style={imageBackground}>{image}</span>
        ) : fallbackIcon}
      </span>
    );
  }

  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px] text-muted-foreground"
      style={imageBackground}
    >
      {image ?? fallbackIcon}
    </span>
  );
};
