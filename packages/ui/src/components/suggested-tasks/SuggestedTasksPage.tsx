import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { observeSuggestedTasks, useSuggestedTasksStore } from '@/stores/useSuggestedTasksStore';
import { useUIStore } from '@/stores/useUIStore';
import { SuggestedTasksInbox } from './SuggestedTasksInbox';

export type SuggestedTasksLeaveReason = 'session' | 'draft';

const projectLabel = (project: ProjectEntry, homeDirectory: string | null) => (
  project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined)
);

function SuggestedTasksRuntimeView({ layout, onLeave }: {
  layout: 'page' | 'mobile';
  onLeave: (reason: SuggestedTasksLeaveReason) => void;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
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
                return selected ? projectLabel(selected, homeDirectory) : '';
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {projects.map((entry) => <SelectItem key={entry.id} value={entry.id}>{projectLabel(entry, homeDirectory)}</SelectItem>)}
          </SelectContent>
        </Select>
        {inbox}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-60 flex-shrink-0 flex-col border-e border-border/50" aria-label={t('suggestedTasks.page.project')}>
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {projects.length === 0 ? <div className="px-2 py-2 typography-meta text-muted-foreground">{t('suggestedTasks.empty.noProject')}</div> : null}
            {projects.map((entry) => {
              const count = summary?.find((item) => item.projectId === entry.id)?.open ?? 0;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  aria-current={entry.id === projectId ? 'page' : undefined}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    entry.id === projectId ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
                  )}
                >
                  <Icon name="folder" className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate oc-ui-start-align" dir="auto">{projectLabel(entry, homeDirectory)}</span>
                  {count > 0 ? <span className="typography-micro text-muted-foreground" dir="auto">{count}</span> : null}
                </button>
              );
            })}
          </div>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto w-full max-w-3xl">{inbox}</div>
        </div>
      </div>
    </div>
  );
}

/** Full configuration stays on web/Electron; phone layouts run and triage only. */
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
