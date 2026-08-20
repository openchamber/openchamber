import React from 'react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { ProjectLabel, ProjectPickerSheet } from '@/components/chat/composer/ui/DraftTargetSelectors';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { Icon } from '@/components/icon/Icon';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';

/** Settings sections list projects alphabetically, unlike the sidebar's manual order. */
export const sortSettingsProjects = (projects: ProjectEntry[]): ProjectEntry[] => {
  return [...projects].sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path));
};

export const SettingsProjectSelector: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const isMobile = useUIStore((state) => state.isMobile);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const sortedProjects = React.useMemo(() => sortSettingsProjects(projects), [projects]);

  const activeProject = React.useMemo(() => {
    return sortedProjects.find((p) => p.id === activeProjectId) ?? sortedProjects[0] ?? null;
  }, [activeProjectId, sortedProjects]);

  if (isVSCode || !activeProject) {
    return null;
  }

  const handleSelect = (projectId: string) => {
    setActiveProject(projectId);
  };

  // Mobile reuses the composer's bottom-sheet project picker: a select popup
  // over a phone viewport cannot scroll far enough for long project lists.
  if (isMobile) {
    return (
      <>
        <div className={cn(className)}>
          <button
            type="button"
            aria-label={t('settings.shared.projectSelector.switchProjectAria')}
            title={t('settings.shared.projectSelector.switchProjectTitle')}
            onClick={() => setSheetOpen(true)}
            className={cn(
              'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/80 bg-transparent px-3 text-left',
              'hover:border-input hover:bg-interactive-hover focus-visible:outline-none focus-visible:border-primary/70 focus-visible:ring-1 focus-visible:ring-primary/50',
            )}
          >
            <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">
              {<ProjectLabel project={activeProject} theme={currentTheme} />}
            </span>
            <Icon name="arrow-down-s" className="size-4 opacity-50" />
          </button>
        </div>
        <ProjectPickerSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          projects={sortedProjects}
          selectedProjectId={activeProject.id}
          onSelectProject={handleSelect}
          theme={currentTheme}
          title={t('settings.shared.projectSelector.sheetTitle')}
          searchPlaceholder={t('settings.shared.projectSelector.searchPlaceholder')}
        />
      </>
    );
  }

  return (
    <div className={cn(className)}>
      <Select
        value={activeProject.id}
        onValueChange={(value) => {
          if (!value) return;
          handleSelect(value);
        }}
      >
        <SelectTrigger
          size="settings"
          className="w-full"
          aria-label={t('settings.shared.projectSelector.switchProjectAria')}
          title={t('settings.shared.projectSelector.switchProjectTitle')}
        >
          <SelectValue>
            {<ProjectLabel project={activeProject} theme={currentTheme} />}
          </SelectValue>
        </SelectTrigger>
        <SelectContent fitContent>
          {sortedProjects.map((project) => (
            <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
              {<ProjectLabel project={project} theme={currentTheme} />}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
