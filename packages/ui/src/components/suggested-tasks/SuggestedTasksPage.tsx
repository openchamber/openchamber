import React from 'react';
import { ProjectLabel, ProjectRailPage } from '@/components/layout/ProjectRailPage';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { observeSuggestedTasks, useSuggestedTasksStore } from '@/stores/useSuggestedTasksStore';
import { useUIStore } from '@/stores/useUIStore';
import { SuggestedTasksInbox } from './SuggestedTasksInbox';

export type SuggestedTasksLeaveReason = 'session' | 'draft';

function SuggestedTasksRuntimeView({ layout, onLeave }: {
  layout: 'page' | 'mobile';
  onLeave: (reason: SuggestedTasksLeaveReason) => void;
}) {
  const { t } = useI18n();
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects));
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const summary = useSuggestedTasksStore((state) => state.summary);
  const [selectedId, setSelectedId] = React.useState(activeProjectId);
  const project = projects.find((entry) => entry.id === selectedId) ?? projects.find((entry) => entry.id === activeProjectId) ?? projects[0];
  const projectId = project?.id ?? '';
  React.useEffect(() => observeSuggestedTasks(), []);
  React.useEffect(() => { void useSuggestedTasksStore.getState().loadSummary(); }, []);

  // The subtree owns one project visit. Late actions may update its cache, but cannot navigate a later visit.
  const inbox = project
    ? <SuggestedTasksInbox key={`${project.id}:${project.path}`} project={project} onLeave={onLeave} />
    : <p className="typography-meta text-muted-foreground">{t('suggestedTasks.empty.noProject')}</p>;

  if (layout === 'mobile') {
    return (
      <div className="h-full min-h-0 space-y-4 overflow-y-auto px-4 py-4">
        <p className="typography-meta text-muted-foreground">{t('suggestedTasks.page.description')}</p>
        <Select value={projectId || undefined} onValueChange={setSelectedId}>
          <SelectTrigger className="w-full" aria-label={t('suggestedTasks.page.project')}>
            <SelectValue placeholder={t('suggestedTasks.page.project')}>
              {(value) => {
                const selected = projects.find((entry) => entry.id === value);
                return selected ? <ProjectLabel project={selected} /> : '';
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {projects.map((entry) => <SelectItem key={entry.id} value={entry.id}><ProjectLabel project={entry} /></SelectItem>)}
          </SelectContent>
        </Select>
        {inbox}
      </div>
    );
  }
  return (
    <ProjectRailPage
      label={t('suggestedTasks.page.project')}
      projects={projects}
      selectedId={projectId}
      onSelect={setSelectedId}
      trailing={(entry) => {
        const count = summary?.find((item) => item.projectId === entry.id)?.open ?? 0;
        return count > 0 ? <span className="typography-micro text-muted-foreground" dir="auto">{count}</span> : null;
      }}
      emptyText={t('suggestedTasks.empty.noProject')}
    >
      {inbox}
    </ProjectRailPage>
  );
}

/** One view per runtime lifetime, so a host switch starts a fresh visit. */
export function SuggestedTasksView(props: React.ComponentProps<typeof SuggestedTasksRuntimeView>) {
  const runtime = useSuggestedTasksRuntime();
  return <SuggestedTasksRuntimeView key={runtime.generation} {...props} />;
}

export function SuggestedTasksPage() {
  const open = useUIStore((state) => state.isSuggestedTasksPageOpen);
  const setOpen = useUIStore((state) => state.setSuggestedTasksPageOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  return open ? <SuggestedTasksView layout="page" onLeave={leave} /> : null;
}
