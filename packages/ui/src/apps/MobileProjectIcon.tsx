import React from 'react';
import { RiFolder6Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';

type MobileProjectIconProject = {
  id: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

export const MobileProjectIcon: React.FC<{
  project: MobileProjectIconProject;
  size?: 'xs' | 'md';
}> = ({ project, size = 'md' }) => {
  const { currentTheme } = useThemeSystem();

  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = resolveProjectColor(project.color);

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
    return (
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        {image ? (
          <span className="flex size-6 items-center justify-center overflow-hidden rounded-md" style={imageBackground}>{image}</span>
        ) : fallbackIcon}
      </span>
    );
  }

  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px] text-muted-foreground"
      style={image ? imageBackground : undefined}
    >
      {image ?? fallbackIcon}
    </span>
  );
};
