import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { requestFileAccess } from '@/lib/desktop';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { parsePlanMarkdown, type ProjectPlanLink, type ProjectRef } from '@/lib/projectContextApi';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Saved plan markdown for the project.
 *
 * Plan mutations touch neither notes nor todos, so this section talks to the
 * store directly instead of routing writes through the container.
 */
export const PlansSection: React.FC<{
  projectRef: ProjectRef;
  plans: ProjectPlanLink[];
  /** Panel-wide filter, matched against plan titles. */
  query: string;
  /** Hosts without a ContextPanel (mobile) render their own plan viewer. */
  onOpenPlan?: (plan: { id: string; title: string }) => void;
}> = ({ projectRef, plans, query, onOpenPlan }) => {
  const { t } = useI18n();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isImporting, setIsImporting] = React.useState(false);
  const [deletingPlanId, setDeletingPlanId] = React.useState<string | null>(null);
  const createPlan = useProjectContextStore((state) => state.createPlan);
  const removePlan = useProjectContextStore((state) => state.deletePlan);
  const setPlanPinned = useProjectContextStore((state) => state.setPlanPinned);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);

  const handleDeletePlan = React.useCallback(
    async (planId: string) => {
      if (deletingPlanId) {
        return;
      }
      setDeletingPlanId(planId);
      try {
        const ok = await removePlan(projectRef, planId);
        if (!ok) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.deletePlanFailed'));
        }
      } finally {
        setDeletingPlanId(null);
      }
    },
    [deletingPlanId, projectRef, removePlan, t]
  );

  // Imported files arrive as a whole markdown document; split it the same way
  // the server would so the stored plan keeps the author's heading.
  const importPlanFromText = React.useCallback(
    async (text: string, fallbackTitle: string) => {
      if (!text.trim()) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.planFileEmpty'));
        return;
      }
      const parsed = parsePlanMarkdown(text, fallbackTitle || t('rightSidebar.contextNotesTodo.plan.defaultTitle'));
      const created = await createPlan(projectRef, { title: parsed.title, body: parsed.body });
      if (!created) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.importPlanFailed'));
        return;
      }
      toast.success(t('rightSidebar.contextNotesTodo.toast.planImported'));
    },
    [createPlan, projectRef, t]
  );

  const handleTriggerImport = React.useCallback(async () => {
    if (isImporting) {
      return;
    }
    const result = await requestFileAccess({
      defaultPath: projectRef.path,
      filters: [
        { name: 'Plan files', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.success && result.path) {
      setIsImporting(true);
      try {
        const params = new URLSearchParams({ path: result.path, allowOutsideWorkspace: 'true' });
        if (result.outsideFileGrant) {
          params.set('outsideFileGrant', result.outsideFileGrant);
        }
        const response = await runtimeFetch(`/api/fs/read?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'));
          return;
        }
        const text = await response.text();
        const fallbackTitle = result.path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '').trim() || '';
        await importPlanFromText(text, fallbackTitle);
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'), description ? { description } : undefined);
      } finally {
        setIsImporting(false);
      }
      return;
    }

    if (result.error === 'Native file picker not available') {
      // Fall back to the HTML file input for web/non-desktop runtimes.
      fileInputRef.current?.click();
    }
  }, [importPlanFromText, isImporting, projectRef.path, t]);

  const handleUploadFile = React.useCallback(
    async (file: File | null) => {
      if (!file) {
        return;
      }
      setIsImporting(true);
      try {
        const text = await file.text();
        const fallbackTitle = file.name.replace(/\.(md|markdown|txt)$/i, '').trim();
        await importPlanFromText(text, fallbackTitle);
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'), description ? { description } : undefined);
      } finally {
        setIsImporting(false);
      }
    },
    [importPlanFromText, t]
  );

  const handleTogglePinned = React.useCallback(
    async (planId: string, pinned: boolean) => {
      const ok = await setPlanPinned(projectRef, planId, pinned);
      if (!ok) {
        const detail = useProjectContextStore.getState().getEntry(projectRef).error;
        toast.error(t('rightSidebar.contextNotesTodo.toast.updatePlanFailed'), detail ? { description: detail } : undefined);
      }
    },
    [projectRef, setPlanPinned, t]
  );

  const visiblePlans = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return plans;
    return plans.filter((plan) => plan.title.toLowerCase().includes(needle));
  }, [plans, query]);

  const handleOpenPlan = React.useCallback(
    (plan: ProjectPlanLink) => {
      if (onOpenPlan) {
        onOpenPlan({ id: plan.id, title: plan.title });
        return;
      }
      const panelDirectory = currentDirectory?.trim() || projectRef.path.trim();
      if (!panelDirectory) {
        return;
      }
      openContextPanelTab(panelDirectory, {
        mode: 'plan',
        projectPlanId: plan.id,
        dedupeKey: `plan:${plan.id}`,
        label: plan.title,
      });
    },
    [currentDirectory, onOpenPlan, openContextPanelTab, projectRef.path]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            void handleUploadFile(file);
            event.currentTarget.value = '';
          }}
        />
        <button
          type="button"
          onClick={handleTriggerImport}
          disabled={isImporting}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('rightSidebar.contextNotesTodo.plans.importFromFile')}
          title={t('rightSidebar.contextNotesTodo.plans.importFromFile')}
        >
          <Icon name="add" className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/40">
        {visiblePlans.length === 0 ? (
          <p className="px-3 py-3 typography-meta text-muted-foreground">
            {query.trim()
              ? t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })
              : t('rightSidebar.contextNotesTodo.plans.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visiblePlans.map((plan) => (
              <li key={plan.id} className="flex items-center gap-1.5 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() => handleOpenPlan(plan)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <span className="min-w-0 truncate typography-ui-label text-foreground">{plan.title}</span>
                  <span className="flex-shrink-0 typography-micro text-muted-foreground">
                    {new Date(plan.createdAt).toLocaleDateString(getCurrentIntlLocale())}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleTogglePinned(plan.id, !plan.pinned)}
                  className={cn(
                    'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    plan.pinned ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-pressed={plan.pinned}
                  aria-label={plan.pinned
                    ? t('rightSidebar.contextNotesTodo.notes.actions.unpin')
                    : t('rightSidebar.contextNotesTodo.notes.actions.pin')}
                  title={plan.pinned
                    ? t('rightSidebar.contextNotesTodo.notes.actions.unpin')
                    : t('rightSidebar.contextNotesTodo.notes.actions.pin')}
                >
                  <Icon name="pushpin" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeletePlan(plan.id)}
                  disabled={deletingPlanId === plan.id}
                  className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                  title={t('rightSidebar.contextNotesTodo.plans.deletePlan')}
                  aria-label={t('rightSidebar.contextNotesTodo.plans.deletePlanWithTitle', { title: plan.title })}
                >
                  <Icon name="delete-bin" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
