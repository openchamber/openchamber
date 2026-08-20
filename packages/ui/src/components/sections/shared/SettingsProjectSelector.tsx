import React from 'react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { ProjectLabel } from '@/components/chat/composer/ui/DraftTargetSelectors';
import { useThemeSystem } from '@/contexts/useThemeSystem';
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

  return (
    <div className={cn(className)}>
      <Select
        value={activeProject.id}
        onValueChange={(value) => {
          if (!value) return;
          setActiveProject(value);
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
