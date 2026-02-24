import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { RiAddLine, RiFolderLine } from '@remixicon/react';
import { isDesktopLocalOriginActive, isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { toast } from '@/components/ui';

export const ProjectsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const projects = useProjectsStore((state) => state.projects);
  const addProject = useProjectsStore((state) => state.addProject);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);

  const handleAddProject = React.useCallback(() => {
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }

    import('@/lib/desktop')
      .then(({ requestDirectoryAccess }) => requestDirectoryAccess(''))
      .then((result) => {
        if (result.success && result.path) {
          const added = addProject(result.path, { id: result.projectId });
          if (!added) {
            toast.error('Failed to add project', {
              description: 'Please select a valid directory.',
            });
            return;
          }
          setSelectedId(added.id);
        } else if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error('Failed to select directory', {
            description: result.error,
          });
        }
      })
      .catch((error) => {
        console.error('Failed to select directory:', error);
        toast.error('Failed to select directory');
      });
  }, [addProject, setSelectedId, tauriIpcAvailable]);

  React.useEffect(() => {
    if (projects.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className={cn('border-b px-3', 'pt-4 pb-3')}>
          <h2 className="text-base font-semibold text-foreground mb-3">Projects</h2>
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">Total {projects.length}</span>
            {!isVSCode && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 -my-1 text-muted-foreground"
                onClick={handleAddProject}
                aria-label="Add project"
              >
                <RiAddLine className="size-4" />
              </Button>
            )}
          </div>
        </div>
      }
    >
      {projects.map((project) => {
        const selected = project.id === selectedId;
        const Icon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const color = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;
        const icon = Icon
          ? (
            <Icon className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground/70')} style={color ? { color } : undefined} />
          )
          : (
            <RiFolderLine className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground/70')} style={color ? { color } : undefined} />
          );

        return (
          <SettingsSidebarItem
            key={project.id}
            title={project.label || project.path}
            icon={icon}
            selected={selected}
            onSelect={() => {
              setSelectedId(project.id);
              onItemSelect?.();
            }}
          />
        );
      })}
    </SettingsSidebarLayout>
  );
};
