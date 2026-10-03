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
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { Icon } from '@/components/icon/Icon';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';

/** Settings sections list projects alphabetically, unlike the sidebar's manual order. */
const sortSettingsProjects = (projects: ProjectEntry[]): ProjectEntry[] => {
  return [...projects].sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path));
};

export const SettingsProjectSelector: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const isMobile = useUIStore((state) => state.isMobile);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const projects = useProjectsStore((state) => state.projects);
  // Settings-only selection. Picking a project here used to call
  // `setActiveProject`, which relocates the chat, the session list and the file
  // tree; reading another project's configuration must not move the app.
  const settingsDirectory = useSettingsDirectory();
  const setSettingsProjectPath = useUIStore((state) => state.setSettingsProjectPath);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const sortedProjects = React.useMemo(() => sortSettingsProjects(projects), [projects]);

  const activeProject = React.useMemo(() => {
    return sortedProjects.find((p) => p.path === settingsDirectory) ?? sortedProjects[0] ?? null;
  }, [settingsDirectory, sortedProjects]);

  if (isVSCode || !activeProject) {
    return null;
  }

  const handleSelect = (projectId: string) => {
    const project = sortedProjects.find((entry) => entry.id === projectId);
    if (project) setSettingsProjectPath(project.path);
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
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
            className={cn(
              dropdownTriggerVariants({ size: 'touch' }),
              'w-full min-w-0',
            )}
          >
            <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">
              <ProjectLabel project={activeProject} theme={currentTheme} />
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
            <ProjectLabel project={activeProject} theme={currentTheme} />
          </SelectValue>
        </SelectTrigger>
        <SelectContent fitContent>
          {sortedProjects.map((project) => (
            <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
              <ProjectLabel project={project} theme={currentTheme} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
