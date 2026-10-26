import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ProjectActionsTab } from '@/components/sections/projects/ProjectActionsTab';
import { ProjectEnvironmentSection } from '@/components/sections/projects/ProjectEnvironmentSection';
import { ProjectGeneralTab } from '@/components/sections/projects/ProjectGeneralTab';
import { ProjectSettingsHeader } from '@/components/sections/projects/ProjectSettingsHeader';
import { ProjectWorktreesTab } from '@/components/sections/projects/ProjectWorktreesTab';
import type { ProjectSettingsTab } from '@/components/sections/projects/projectSettingsTabs';
import { useProjectSetup } from '@/components/sections/projects/useProjectSetup';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import type { ProjectEntry } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

type ProjectSettingsPanelProps = {
  project: ProjectEntry;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  tab: ProjectSettingsTab;
  onTabChange: (tab: ProjectSettingsTab) => void;
  /** Settings frames the panel as a page with the save indicator; the edit dialog shows it bare. */
  frame: 'page' | 'dialog';
  /** Opens the project's worktrees page; absent where that page is not reachable. */
  onOpenWorktrees?: () => void;
  /** Closes the project, as the sidebar's "Close project" does; shown only in the page frame. */
  onCloseProject?: () => void;
};

const isProjectSettingsTab = (id: string): id is ProjectSettingsTab => (
  id === 'general' || id === 'actions' || id === 'worktrees' || id === 'environment'
);

/**
 * Everything a project carries, on one page: the icon, colour and name in
 * the header, and below it a tab per concern. Settings and the project's
 * edit dialog both show this panel.
 */
export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  tab,
  onTabChange,
  frame,
  onOpenWorktrees,
  onCloseProject,
}) => {
  const { t } = useI18n();
  const form = useProjectIdentityForm(project);
  useProjectIdentityAutoSave(form, onIdentitySave);

  const projectRef = React.useMemo(() => ({ id: project.id, path: project.path }), [project.id, project.path]);
  const setupState = useProjectSetup(projectRef);
  // VS Code runs no OpenChamber server that could apply environment settings.
  const hasEnvironment = !isVSCodeRuntime();
  const activeTab = tab === 'environment' && !hasEnvironment ? 'general' : tab;

  const tabs = React.useMemo<SortableTabsStripItem[]>(() => [
    { id: 'general', label: t('settings.projects.tab.general') },
    { id: 'actions', label: t('settings.projects.tab.actions') },
    { id: 'worktrees', label: t('settings.projects.tab.worktrees') },
    ...(hasEnvironment ? [{ id: 'environment', label: t('settings.projects.tab.environment') }] : []),
  ], [hasEnvironment, t]);

  const header = <ProjectSettingsHeader form={form} />;
  const tabStrip = (
    <SortableTabsStrip
      items={tabs}
      activeId={activeTab}
      onSelect={(id) => {
        if (isProjectSettingsTab(id)) onTabChange(id);
      }}
      layoutMode="fit"
      variant="active-pill"
      pillSize="form"
      className="h-8 max-w-[32rem]"
    />
  );
  const tabContent = (
    <>
      {activeTab === 'general' ? <ProjectGeneralTab form={form} projectRef={projectRef} setupState={setupState} /> : null}
      {activeTab === 'actions' ? <ProjectActionsTab setupState={setupState} /> : null}
      {activeTab === 'worktrees' ? <ProjectWorktreesTab projectRef={projectRef} setupState={setupState} onOpenWorktrees={onOpenWorktrees} /> : null}
      {activeTab === 'environment' ? <ProjectEnvironmentSection projectRef={projectRef} /> : null}
    </>
  );

  if (frame === 'page') {
    const closeButton = onCloseProject ? (
      <Button
        variant="ghost"
        size="xs"
        className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
        data-settings-item="projects.close"
        onClick={onCloseProject}
      >
        <Icon name="close" className="size-3.5" />
        {t('settings.projects.page.actions.closeProject')}
      </Button>
    ) : null;
    return (
      <SettingsPageLayout title={header} headerEnd={closeButton} showSaveStatus outerClassName="bg-background">
        <div className="mb-8">{tabStrip}</div>
        {tabContent}
      </SettingsPageLayout>
    );
  }

  // The dialog has a fixed height: the header and tabs stay put and only the
  // tab's content scrolls, so switching tabs never resizes the dialog.
  return (
    <div className="flex min-h-0 flex-1 flex-col @container">
      <div className="shrink-0 space-y-6 px-4 pt-6 pb-5 sm:px-6 sm:pt-8">
        {header}
        {tabStrip}
      </div>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="w-full">
        <div className="px-4 pb-6 sm:px-6 [&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0">{tabContent}</div>
      </ScrollableOverlay>
    </div>
  );
};
