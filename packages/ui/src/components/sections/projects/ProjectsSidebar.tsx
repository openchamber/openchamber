import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { Icon } from "@/components/icon/Icon";
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { CodexImportDialog } from './CodexImportDialog';

export const ProjectsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const { currentTheme } = useThemeSystem();
  const { imports } = useRuntimeAPIs();
  const [codexImportOpen, setCodexImportOpen] = React.useState(false);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const handleAddProject = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

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
          <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.page.projects.title')}</h2>
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{t('settings.projects.sidebar.total', { count: projects.length })}</span>
            {(!isVSCode || imports) && (
              <div className="flex items-center gap-1">
                {imports ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 -my-1 text-muted-foreground"
                    onClick={() => setCodexImportOpen(true)}
                    aria-label={t('settings.projects.codexImport.action')}
                    data-settings-item="projects.import-codex"
                  >
                    <Icon name="chat-history" className="size-4" />
                  </Button>
                ) : null}
                {!isVSCode ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 -my-1 text-muted-foreground"
                    onClick={handleAddProject}
                    aria-label={t('settings.projects.sidebar.actions.addProject')}
                  >
                    <Icon name="add" className="size-4" />
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      }
    >
      {projects.map((project) => {
        const selected = project.id === selectedId;
        const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const color = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;
        const fallbackIcon = iconName
          ? (
            <Icon name={iconName} className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground/70')} style={color ? { color } : undefined} />
          )
          : (
            <Icon name="folder" className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground/70')} style={color ? { color } : undefined} />
          );
        const icon = project.iconImage
          ? (
            <span
              className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
              style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
            >
              <ProjectIconImage
                project={project}
                options={{
                  themeVariant: currentTheme.metadata.variant,
                  iconColor: currentTheme.colors.surface.foreground,
                }}
                className="h-full w-full object-contain"
                fallback={fallbackIcon}
              />
            </span>
          )
          : fallbackIcon;

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
      {imports ? <CodexImportDialog open={codexImportOpen} onOpenChange={setCodexImportOpen} /> : null}
    </SettingsSidebarLayout>
  );
};
