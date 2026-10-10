import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { isChatDirectoryForHome } from '@/lib/chatDirectories';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * The icon of the project a session belongs to, drawn the way the sidebar
 * draws it: the project's image, its chosen icon in its colour, or a folder.
 * A managed chat has no project and gets the chat icon. Nothing renders when
 * the directory matches no known project.
 */
export function SessionProjectIcon({ directory, className }: { directory: string | null; className?: string }): React.ReactNode {
  const { currentTheme } = useThemeSystem();
  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const isChat = isChatDirectoryForHome(directory, homeDirectory);
  const project = React.useMemo(
    () => (isChat || !directory ? null : resolveProjectForSessionDirectory(projects, worktreesByProject, directory)),
    [directory, isChat, projects, worktreesByProject],
  );

  if (isChat) {
    return <Icon name="chat-4" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/80', className)} />;
  }
  if (!project) {
    return null;
  }

  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
  const glyph = iconName ? (
    <Icon name={iconName} className={cn('h-3.5 w-3.5 shrink-0', className)} style={iconColor ? { color: iconColor } : undefined} />
  ) : (
    <Icon name="folder" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/80', className)} style={iconColor ? { color: iconColor } : undefined} />
  );

  if (!project.iconImage) {
    return glyph;
  }

  return (
    <span
      className={cn('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]', className)}
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
    >
      <ProjectIconImage
        project={{ id: project.id, iconImage: project.iconImage }}
        options={{
          themeVariant: currentTheme.metadata.variant,
          iconColor: currentTheme.colors.surface.foreground,
        }}
        className="h-full w-full object-contain"
        fallback={glyph}
      />
    </span>
  );
}
