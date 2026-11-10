import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { requestFileAccess } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import {
  PROJECT_PLAN_TITLE_MAX_LENGTH,
  parsePlanMarkdown,
  resolveProjectContextId,
  type ProjectPlanLink,
  type ProjectPlanProgress,
  type ProjectRef,
} from '@/lib/projectContextApi';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { KnowledgeComposer } from './KnowledgeComposer';
import { KNOWLEDGE_ICON_BUTTON_CLASS, useKnowledgeYieldClass } from './knowledgeRowStyle';
import { KnowledgeMenu, KnowledgePinToggle, KnowledgeRowContextMenu } from './KnowledgeActions';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { formatKnowledgeDate } from './knowledgeFormat';
import { planDeleteKey, usePendingKnowledgeDeletes } from './pendingKnowledgeDeletes';
import { usePlanActions } from './usePlanActions';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Agents tick plan steps with their own file tools, which announce nothing,
 * so the list re-reads while it is on screen. The server answers with each
 * plan's step counts, never its text, and re-reads only files that changed.
 */
const PLAN_LIST_REFRESH_MS = 10_000;

/** Ticked steps of the plan's `## Steps` checklist, or a check once all are. */
export const PlanProgressLabel: React.FC<{ progress: ProjectPlanProgress }> = ({ progress }) => {
  const { t } = useI18n();
  if (progress.done >= progress.total) {
    const done = t('rightSidebar.contextNotesTodo.plans.progress.done');
    return (
      <span className="inline-flex shrink-0 items-center" title={done}>
        <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
        <span className="sr-only">{done}</span>
      </span>
    );
  }
  return (
    <span
      className="shrink-0 typography-micro tabular-nums text-muted-foreground"
      title={t('rightSidebar.contextNotesTodo.plans.progress.title', { done: progress.done, total: progress.total })}
    >
      {`${progress.done}/${progress.total}`}
    </span>
  );
};

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
  /** Opens the plan: in place in the panel, or the host's own viewer (mobile).
      The plan carries its owner so a host viewer never guesses the project. */
  onOpenPlan: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  pinnedPlanIds: ReadonlySet<string>;
  onTogglePinned: (planId: string, pinned: boolean) => Promise<boolean>;
  /** The plan open beside the list (split layout), marked as selected. */
  selectedPlanId: string | null;
  /** A plan moved to or from the team's folder: its project, and its id before and after. */
  onPlanMoved: (projectId: string, previousId: string, movedId: string) => void;
}> = ({ projectRef, plans, query, onOpenPlan, pinnedPlanIds, onTogglePinned, selectedPlanId, onPlanMoved }) => {
  const { t } = useI18n();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isImporting, setIsImporting] = React.useState(false);
  const createPlan = useProjectContextStore((state) => state.createPlan);
  const pendingDeletes = usePendingKnowledgeDeletes();
  const { actionsFor, movingPlanId } = usePlanActions(projectRef, onPlanMoved);
  const yieldToActions = useKnowledgeYieldClass();
  const isMobile = useUIStore((state) => state.isMobile);
  const loadContext = useProjectContextStore((state) => state.load);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadContext(projectRef, { force: true });
    }, PLAN_LIST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadContext, projectRef]);

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
        { name: t('contextTooltips.workspace.plans.filterPlanFiles'), extensions: ['md', 'markdown', 'txt'] },
        { name: t('contextTooltips.workspace.plans.filterAllFiles'), extensions: ['*'] },
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
      const ok = await onTogglePinned(planId, pinned);
      if (!ok) {
        const detail = useProjectContextStore.getState().getEntry(projectRef).error;
        toast.error(t('rightSidebar.contextNotesTodo.toast.updatePlanFailed'), detail ? { description: detail } : undefined);
      }
    },
    [onTogglePinned, projectRef, t]
  );

  const visiblePlans = React.useMemo(
    () => plans.filter((plan) => (
      !pendingDeletes.has(planDeleteKey(projectRef, plan.id)) && matchesRankQuery([plan.title], query)
    )),
    [pendingDeletes, plans, projectRef, query],
  );

  const handleOpenPlan = React.useCallback(
    (plan: ProjectPlanLink) => onOpenPlan({ id: plan.id, title: plan.title, projectRef }),
    [onOpenPlan, projectRef]
  );

  // Which project the section shows now, read after an await: a create that
  // resolves once the user has left the section or the project must not open
  // its plan over whatever is on screen by then.
  const shownProjectIdRef = React.useRef<string | null>(resolveProjectContextId(projectRef));
  React.useEffect(() => {
    shownProjectIdRef.current = resolveProjectContextId(projectRef);
    return () => { shownProjectIdRef.current = null; };
  }, [projectRef]);

  // A new plan opens straight away: the title is all the composer asks for,
  // and the rest is written in the editor.
  const handleCreatePlan = React.useCallback(async (title: string) => {
    const createdFor = resolveProjectContextId(projectRef);
    const created = await createPlan(projectRef, { title, body: '' });
    if (!created) {
      const detail = useProjectContextStore.getState().getEntry(projectRef).error;
      toast.error(t('rightSidebar.contextNotesTodo.toast.createPlanFailed'), detail ? { description: detail } : undefined);
      return false;
    }
    if (shownProjectIdRef.current === createdFor) handleOpenPlan(created);
    return true;
  }, [createPlan, handleOpenPlan, projectRef, t]);

  return (
    <div className="space-y-2">
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
      <KnowledgeComposer
        placeholder={t('rightSidebar.contextNotesTodo.plans.newPlaceholder')}
        addLabel={t('rightSidebar.contextNotesTodo.plans.create')}
        maxLength={PROJECT_PLAN_TITLE_MAX_LENGTH}
        projectPath={projectRef.path}
        draftKind="plan"
        dictation={false}
        onSubmit={handleCreatePlan}
        extraActions={(
          <ButtonTooltip label={t('rightSidebar.contextNotesTodo.plans.importFromFile')} className="shrink-0">
            <button
              type="button"
              onClick={handleTriggerImport}
              disabled={isImporting}
              className={KNOWLEDGE_ICON_BUTTON_CLASS}
              aria-label={t('rightSidebar.contextNotesTodo.plans.importFromFile')}
            >
              <Icon name="upload-2" className="h-3.5 w-3.5" />
            </button>
          </ButtonTooltip>
        )}
      />

      {visiblePlans.length === 0 ? (
        <p className="px-1 typography-meta text-muted-foreground">
          {query.trim()
            ? t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })
            : t('rightSidebar.contextNotesTodo.plans.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {visiblePlans.map((plan) => {
            const pinned = pinnedPlanIds.has(plan.id);
            const selected = plan.id === selectedPlanId;
            const menuItems = actionsFor(plan);
            return (
              <KnowledgeRowContextMenu
                key={plan.id}
                items={menuItems}
                disabled={movingPlanId === plan.id}
                render={(
                  <li
                    data-knowledge-entry-id={plan.id}
                    aria-current={selected ? 'true' : undefined}
                    className={cn('group/knowledge relative flex items-center rounded-md', selected && 'bg-interactive-selection/40')}
                  />
                )}
              >
                <button
                  type="button"
                  onClick={() => handleOpenPlan(plan)}
                  className={cn(
                    'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-start transition-colors focus-visible:outline-none',
                    selected ? 'text-foreground' : 'oc-title-rest hover:text-foreground',
                  )}
                >
                  <span className="min-w-0 truncate typography-ui-label" dir="auto" title={plan.title}>{plan.title}</span>
                  {plan.source === 'shared' ? (
                    <span className="shrink-0 typography-micro text-muted-foreground">
                      {t('rightSidebar.contextNotesTodo.plans.sharedBadge')}
                    </span>
                  ) : null}
                  {plan.progress ? <PlanProgressLabel progress={plan.progress} /> : null}
                  {/* The date keeps its place; the actions show over it. */}
                  <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground transition-opacity', yieldToActions)}>
                    {pinned && !isMobile ? (
                      <span className="inline-flex" title={t('rightSidebar.contextNotesTodo.pin.attached')}>
                        <Icon name="pushpin-2-fill" className="size-3" />
                        <span className="sr-only">{t('rightSidebar.contextNotesTodo.pin.attached')}</span>
                      </span>
                    ) : null}
                    {formatKnowledgeDate(plan.createdAt)}
                  </span>
                </button>
                {/* Over the date, so it takes clicks only while it shows: an
                    invisible pin under the date would toggle on a plain click. */}
                <div
                  className={cn(
                    'flex flex-shrink-0 items-center gap-0.5 pe-1',
                    !isMobile && 'pointer-events-none absolute inset-y-0 end-0 group-hover/knowledge:pointer-events-auto group-has-[:focus-visible]/knowledge:pointer-events-auto',
                  )}
                >
                  <KnowledgePinToggle
                    pinned={pinned}
                    onToggle={() => void handleTogglePinned(plan.id, !pinned)}
                  />
                  <KnowledgeMenu disabled={movingPlanId === plan.id} items={menuItems} />
                </div>
              </KnowledgeRowContextMenu>
            );
          })}
        </ul>
      )}
    </div>
  );
};
