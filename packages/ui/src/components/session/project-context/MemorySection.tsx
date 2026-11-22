import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';

import { useEmojiPicker } from '@/components/emoji/useEmojiPicker';
import { toast } from '@/components/ui';
import { AttachedOverlayScrollbar } from '@/components/ui/AttachedOverlayScrollbar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KnowledgeCard } from './KnowledgeCard';
import { KnowledgeEntryView } from './KnowledgeEntryView';
import { KnowledgeSplit } from './KnowledgeSplit';
import { KnowledgeMenu } from './KnowledgeActions';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { memoryDeleteKey, scheduleKnowledgeDelete, usePendingKnowledgeDeletes } from './pendingKnowledgeDeletes';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { AGENT_MEMORY_BODY_MAX_LENGTH, AGENT_MEMORY_TITLE_MAX_LENGTH, type AgentMemoryDream, type AgentMemoryEntry, type AgentMemoryScope } from '@/lib/agentMemoryApi';
import { classifyMemory, memoryViewKey, type MemoryBadge } from '@/lib/agentMemoryBadges';
import { cn } from '@/lib/utils';
import { selectProjectMemoryForPath, useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { startMemoryTidy, startMemoryToDocs } from './memoryTidy';

const MemoryTidyButton: React.FC<{ projectPath: string | null }> = ({ projectPath }) => {
  const { t } = useI18n();
  const [starting, setStarting] = React.useState(false);
  const ready = useAgentMemoryStore((state) => (
    Boolean(projectPath)
    && state.loaded
    && !state.loading
    && !state.globalFailed
    && !state.projectFailed
    && state.projectPath === projectPath
    && state.global.length + state.project.length > 0
  ));

  const handleClick = async () => {
    if (!projectPath || starting) return;
    const { global, project } = useAgentMemoryStore.getState();
    setStarting(true);
    try {
      const outcome = await startMemoryTidy({
        projectPath,
        title: t('rightSidebar.contextNotesTodo.memory.tidy.sessionTitle'),
        memory: { global, project },
      });
      if (!outcome.ok) {
        toast.error(t(outcome.reason === 'no-model'
          ? 'rightSidebar.contextNotesTodo.memory.tidy.noModel'
          : 'rightSidebar.contextNotesTodo.memory.tidy.failed'));
      }
    } catch {
      toast.error(t('rightSidebar.contextNotesTodo.memory.tidy.failed'));
    } finally {
      setStarting(false);
    }
  };

  return (
    <ButtonTooltip label={t('contextTooltips.workspace.memory.tidy')} className="ms-auto shrink-0">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={!ready || starting}
        onClick={() => void handleClick()}
        className="gap-1 border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:bg-[var(--status-info-background)] hover:text-[var(--status-info)]"
      >
        <Icon name={starting ? 'loader-4' : 'brush'} className={cn('size-3.5', starting && 'animate-spin')} />
        {t('rightSidebar.contextNotesTodo.memory.tidy.action')}
      </Button>
    </ButtonTooltip>
  );
};

const DreamLine: React.FC<{ dream: AgentMemoryDream; onUndo: () => void; undoing: boolean }> = ({ dream, onUndo, undoing }) => {
  const { t } = useI18n();
  const date = new Intl.DateTimeFormat(getCurrentIntlLocale(), { day: 'numeric', month: 'long' }).format(dream.finishedAt);
  const changed = dream.merged + dream.removed + dream.rewritten > 0;
  const summary = dream.undone
    ? t('rightSidebar.contextNotesTodo.memory.dream.undone', { date })
    : dream.status === 'failed'
      ? t('rightSidebar.contextNotesTodo.memory.dream.failed', { date })
      : changed
        ? t('rightSidebar.contextNotesTodo.memory.dream.tidied', { date })
        : t('rightSidebar.contextNotesTodo.memory.dream.nothing', { date });
  const counts = dream.undone || !changed ? [] : [
    dream.merged > 0 ? t('rightSidebar.contextNotesTodo.memory.dream.merged', { count: dream.merged }) : null,
    dream.removed > 0 ? t('rightSidebar.contextNotesTodo.memory.dream.removed', { count: dream.removed }) : null,
    dream.rewritten > 0 ? t('rightSidebar.contextNotesTodo.memory.dream.rewritten', { count: dream.rewritten }) : null,
  ].filter((part): part is string => part !== null);
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-micro text-muted-foreground">
      <Icon name="moon" className="size-3 shrink-0" />
      <span>{summary}</span>
      {counts.map((part) => (
        <React.Fragment key={part}>
          <span aria-hidden="true">·</span>
          <span>{part}</span>
        </React.Fragment>
      ))}
      {dream.canUndo ? (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            disabled={undoing}
            onClick={onUndo}
            className="text-foreground/80 hover:text-foreground disabled:opacity-50"
          >
            {t('rightSidebar.contextNotesTodo.memory.dream.undo')}
          </button>
        </>
      ) : null}
    </p>
  );
};

const DocsLine: React.FC<{ projectPath: string; entries: AgentMemoryEntry[] }> = ({ projectPath, entries }) => {
  const { t } = useI18n();
  const [starting, setStarting] = React.useState(false);
  const handleMove = async () => {
    setStarting(true);
    try {
      const outcome = await startMemoryToDocs({
        projectPath,
        title: t('rightSidebar.contextNotesTodo.memory.toDocs.sessionTitle'),
        entries,
      });
      if (!outcome.ok) {
        toast.error(t(outcome.reason === 'no-model'
          ? 'rightSidebar.contextNotesTodo.memory.tidy.noModel'
          : 'rightSidebar.contextNotesTodo.memory.toDocs.failed'));
      }
    } catch {
      toast.error(t('rightSidebar.contextNotesTodo.memory.toDocs.failed'));
    } finally {
      setStarting(false);
    }
  };
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-micro text-muted-foreground">
      <Icon name="file-text" className="size-3 shrink-0" />
      <span>{t('rightSidebar.contextNotesTodo.memory.toDocs.summary', { count: entries.length })}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        disabled={starting}
        onClick={() => void handleMove()}
        className="text-foreground/80 hover:text-foreground disabled:opacity-50"
      >
        {t('rightSidebar.contextNotesTodo.memory.toDocs.action')}
      </button>
    </p>
  );
};

const MemoryBadgePill: React.FC<{ badge: MemoryBadge }> = ({ badge }) => {
  const { t } = useI18n();
  if (!badge) return null;
  return (
    <span
      className={cn(
        'flex-shrink-0 rounded-full px-1.5 py-px typography-micro font-medium',
        badge === 'new'
          ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
          : 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
      )}
    >
      {t(badge === 'new'
        ? 'rightSidebar.contextNotesTodo.memory.badge.new'
        : 'rightSidebar.contextNotesTodo.memory.badge.changed')}
    </span>
  );
};

const MemoryMeta: React.FC<{ entry: AgentMemoryEntry; scopeLabel?: string }> = ({ entry, scopeLabel }) => {
  const { t } = useI18n();
  const typeLabel = t(`rightSidebar.contextNotesTodo.memory.type.${entry.type}` as Parameters<typeof t>[0]);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-micro text-muted-foreground">
      {scopeLabel ? (
        <>
          <span>{scopeLabel}</span>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      <span>{typeLabel}</span>
      {entry.flagged ? (
        <span className="flex items-center gap-1 text-[var(--status-error)]">
          <Icon name="error-warning" className="h-3 w-3 flex-shrink-0" />
          {t('rightSidebar.contextNotesTodo.memory.flagged')}
        </span>
      ) : null}
    </span>
  );
};

const MemoryCard: React.FC<{
  entry: AgentMemoryEntry;
  badge: MemoryBadge;
  onOpen: () => void;
  onDelete: () => void;
  selected: boolean;
}> = ({ entry, badge, onOpen, onDelete , selected}) => {
  const { t } = useI18n();
  const menuItems = [{
    id: 'delete',
    label: t('rightSidebar.contextNotesTodo.memory.actions.delete'),
    destructive: true,
    onSelect: onDelete,
  }];
  return (
    <KnowledgeCard
      selected={selected}
      entryId={entry.id}
      onOpen={onOpen}
      label={entry.title}
      header={(
        <>
          <MemoryBadgePill badge={badge} />
          <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" dir="auto" title={entry.title}>
            {entry.title}
          </span>
        </>
      )}
      actions={<KnowledgeMenu items={menuItems} />}
      menuItems={menuItems}
      footer={<MemoryMeta entry={entry} />}
    >
      <p className="line-clamp-2 whitespace-pre-wrap break-words typography-meta text-muted-foreground" dir="auto">
        {entry.body}
      </p>
    </KnowledgeCard>
  );
};

const MemoryView: React.FC<{
  entry: AgentMemoryEntry;
  badge: MemoryBadge;
  scopeLabel: string;
  onSave: (patch: { title: string; body: string }) => void;
  onDelete: () => void;
  onClose: () => void;
  showBack: boolean;
}> = ({ entry, badge, scopeLabel, onSave, onDelete, onClose , showBack}) => {
  const { t } = useI18n();
  const [titleDraft, setTitleDraft] = React.useState(entry.title);
  const [bodyDraft, setBodyDraft] = React.useState(entry.body);
  const seenRef = React.useRef({ title: entry.title, body: entry.body });

  React.useEffect(() => {
    const seen = seenRef.current;
    if (entry.title === seen.title && entry.body === seen.body) return;
    seenRef.current = { title: entry.title, body: entry.body };
    if (titleDraft === seen.title && bodyDraft === seen.body) {
      setTitleDraft(entry.title);
      setBodyDraft(entry.body);
    }
  }, [bodyDraft, entry.body, entry.title, titleDraft]);

  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const [bodyScroller, setBodyScroller] = React.useState<HTMLTextAreaElement | null>(null);
  const emojiPicker = useEmojiPicker(bodyRef);
  const commitRef = React.useRef<() => void>(() => {});
  commitRef.current = () => {
    const title = titleDraft.trim();
    const body = bodyDraft.trim();
    if (!title || !body) {
      setTitleDraft(entry.title);
      setBodyDraft(entry.body);
      return;
    }
    if (title === entry.title && body === entry.body) {
      return;
    }
    seenRef.current = { title, body };
    onSave({ title, body });
  };
  React.useEffect(() => () => commitRef.current(), []);

  return (
    <KnowledgeEntryView
      showBack={showBack}
      backLabel={t('rightSidebar.contextNotesTodo.memory.actions.back')}
      onClose={onClose}
      meta={(
        <span className="flex min-w-0 items-center gap-1.5">
          <MemoryBadgePill badge={badge} />
          <MemoryMeta entry={entry} scopeLabel={scopeLabel} />
        </span>
      )}
      actions={(
        <KnowledgeMenu
          alwaysVisible
          items={[{
            id: 'delete',
            label: t('rightSidebar.contextNotesTodo.memory.actions.delete'),
            destructive: true,
            onSelect: onDelete,
          }]}
        />
      )}
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value.slice(0, AGENT_MEMORY_TITLE_MAX_LENGTH))}
          onBlur={() => commitRef.current()}
          aria-label={t('rightSidebar.contextNotesTodo.memory.actions.editTitle')}
          dir="auto"
          className="w-full flex-shrink-0 bg-transparent typography-ui-header font-semibold text-foreground outline-none focus-visible:outline-none"
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <textarea
            ref={(node) => {
              bodyRef.current = node;
              setBodyScroller(node);
            }}
            value={bodyDraft}
            onChange={(event) => setBodyDraft(event.target.value.slice(0, AGENT_MEMORY_BODY_MAX_LENGTH))}
            onBlur={() => commitRef.current()}
            aria-label={t('rightSidebar.contextNotesTodo.memory.actions.editBody')}
            dir="auto"
            className="min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent typography-ui-label leading-relaxed text-foreground outline-none focus-visible:outline-none"
          />
          <AttachedOverlayScrollbar scroller={bodyScroller} disableHorizontal />
        </div>
        {emojiPicker}
      </div>
    </KnowledgeEntryView>
  );
};

export const MemorySection: React.FC<{
  projectPath: string | null;
  query: string;
  openMemoryId: string | null;
  onOpenMemory: (memoryId: string | null) => void;
  split: boolean;
}> = ({ projectPath, query, openMemoryId, onOpenMemory, split }) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<AgentMemoryScope>('project');

  const globalEntries = useAgentMemoryStore((state) => state.global);
  const projectEntries = useAgentMemoryStore((state) => selectProjectMemoryForPath(state, projectPath));
  const scopePickedRef = React.useRef(false);
  React.useEffect(() => {
    if (scopePickedRef.current) return;
    if (scope === 'project' && projectEntries.length === 0 && globalEntries.length > 0) setScope('global');
    if (scope === 'global' && globalEntries.length === 0 && projectEntries.length > 0) setScope('project');
  }, [globalEntries.length, projectEntries.length, scope]);
  const globalFailed = useAgentMemoryStore((state) => state.globalFailed);
  const projectFailed = useAgentMemoryStore((state) => state.projectFailed);
  const deleteEntry = useAgentMemoryStore((state) => state.deleteEntry);
  const saveEntry = useAgentMemoryStore((state) => state.saveEntry);
  const markViewed = useUIStore((state) => state.markAgentMemoryViewed);
  const pendingDeletes = usePendingKnowledgeDeletes();

  const entries = scope === 'global' ? globalEntries : projectEntries;
  const scopeFailed = scope === 'global' ? globalFailed : projectFailed;
  const viewKey = memoryViewKey(scope, projectPath);
  const storedViewedAt = useUIStore((state) => state.agentMemoryViewedAt[viewKey] ?? 0);

  const baselineRef = React.useRef(storedViewedAt);
  const [baseline, setBaseline] = React.useState(storedViewedAt);
  React.useEffect(() => {
    baselineRef.current = useUIStore.getState().agentMemoryViewedAt[viewKey] ?? 0;
    setBaseline(baselineRef.current);
    return () => {
      markViewed(viewKey, Date.now());
    };
  }, [markViewed, viewKey]);

  const visibleEntries = React.useMemo(
    () => entries.filter((entry) => (
      !pendingDeletes.has(memoryDeleteKey(scope, entry.id)) && matchesRankQuery([entry.title, entry.body], query)
    )),
    [entries, pendingDeletes, query, scope],
  );

  const followedQueryRef = React.useRef('');
  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === followedQueryRef.current) return;
    followedQueryRef.current = trimmed;
    if (!trimmed || visibleEntries.length > 0) return;
    const otherScope: AgentMemoryScope = scope === 'global' ? 'project' : 'global';
    const otherEntries = otherScope === 'global' ? globalEntries : projectEntries;
    if (otherEntries.some((entry) => matchesRankQuery([entry.title, entry.body], query))) {
      setScope(otherScope);
    }
  }, [globalEntries, projectEntries, query, scope, visibleEntries.length]);

  const openEntry = React.useMemo(
    () => (openMemoryId ? entries.find((entry) => entry.id === openMemoryId) ?? null : null),
    [entries, openMemoryId],
  );

  React.useEffect(() => {
    if (openMemoryId && !openEntry) onOpenMemory(null);
  }, [onOpenMemory, openEntry, openMemoryId]);

  const handleDelete = React.useCallback((memoryId: string) => {
    if (openMemoryId === memoryId) onOpenMemory(null);
    scheduleKnowledgeDelete({
      key: memoryDeleteKey(scope, memoryId),
      message: t('rightSidebar.contextNotesTodo.deleted.memory'),
      undoLabel: t('rightSidebar.contextNotesTodo.undo'),
      run: () => deleteEntry(scope, memoryId, projectPath),
      onFailure: () => {
        const detail = useAgentMemoryStore.getState().error;
        toast.error(
          t('rightSidebar.contextNotesTodo.memory.toast.deleteFailed'),
          detail ? { description: detail } : undefined,
        );
      },
    });
  }, [deleteEntry, onOpenMemory, openMemoryId, projectPath, scope, t]);

  const handleSave = React.useCallback(async (memoryId: string, patch: { title?: string; body?: string }) => {
    if (!await saveEntry(scope, memoryId, patch)) {
      const detail = useAgentMemoryStore.getState().error;
      toast.error(
        t('rightSidebar.contextNotesTodo.memory.toast.saveFailed'),
        detail ? { description: detail } : undefined,
      );
    }
  }, [saveEntry, scope, t]);

  const dream = useAgentMemoryStore((state) => state.dream);
  const undoDream = useAgentMemoryStore((state) => state.undoDream);
  const dreamOwner = useAgentMemoryStore((state) => state.projectPath);
  const scopeDream = scope === 'global' ? dream.global : dreamOwner === projectPath ? dream.project : null;
  const toDocsEntries = React.useMemo(() => {
    const ids = new Set(scope === 'project' ? scopeDream?.toDocs ?? [] : []);
    return projectEntries.filter((entry) => ids.has(entry.id));
  }, [projectEntries, scope, scopeDream]);
  const [undoing, setUndoing] = React.useState(false);
  const handleUndoDream = React.useCallback(async () => {
    setUndoing(true);
    const undone = await undoDream(scope, projectPath);
    setUndoing(false);
    if (!undone) toast.error(t('rightSidebar.contextNotesTodo.memory.dream.undoFailed'));
  }, [projectPath, scope, t, undoDream]);

  const scopeOptions: Array<{ id: AgentMemoryScope; label: string; tooltip: string; count: number }> = [
    {
      id: 'project',
      label: t('rightSidebar.contextNotesTodo.memory.scope.project'),
      tooltip: t('contextTooltips.workspace.memory.scope.project'),
      count: projectEntries.length,
    },
    {
      id: 'global',
      label: t('rightSidebar.contextNotesTodo.memory.scope.global'),
      tooltip: t('contextTooltips.workspace.memory.scope.global'),
      count: globalEntries.length,
    },
  ];

  const openView = openEntry ? (
    <MemoryView
      key={openEntry.id}
      entry={openEntry}
      badge={classifyMemory(openEntry, baseline)}
      scopeLabel={scopeOptions.find((option) => option.id === scope)?.label ?? ''}
      onSave={(patch) => void handleSave(openEntry.id, patch)}
      onDelete={() => handleDelete(openEntry.id)}
      showBack={!split}
      onClose={() => onOpenMemory(null)}
    />
  ) : null;

  const list = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <div role="group" aria-label={t('rightSidebar.contextNotesTodo.memory.scope.label')} className="flex items-center gap-1">
          {scopeOptions.map((option) => (
            <Tooltip key={option.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="chip"
                  size="xs"
                  aria-pressed={scope === option.id}
                  className="!font-normal"
                  onClick={() => {
                    scopePickedRef.current = true;
                    setScope(option.id);
                  }}
                >
                  {`${option.label} ${option.count}`}
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{option.tooltip}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <MemoryTidyButton projectPath={projectPath} />
      </div>

      {scopeDream ? <DreamLine dream={scopeDream} undoing={undoing} onUndo={() => void handleUndoDream()} /> : null}
      {scope === 'project' && projectPath && toDocsEntries.length > 0 ? <DocsLine projectPath={projectPath} entries={toDocsEntries} /> : null}

      {scope === 'project' && !projectPath ? (
        <p className="typography-meta text-muted-foreground">
          {t('rightSidebar.contextNotesTodo.memory.empty.noProject')}
        </p>
      ) : scopeFailed ? (
        <p className="typography-meta text-muted-foreground">
          {t('rightSidebar.contextNotesTodo.memory.empty.unavailable')}
        </p>
      ) : visibleEntries.length === 0 ? (
        <p className="typography-meta text-muted-foreground">
          {query.trim()
            ? t('rightSidebar.contextNotesTodo.memory.empty.noMatches')
            : t('rightSidebar.contextNotesTodo.memory.empty.nothing')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visibleEntries.map((entry) => (
            <MemoryCard
              key={entry.id}
              selected={split && entry.id === openMemoryId}
              entry={entry}
              badge={classifyMemory(entry, baseline)}
              onOpen={() => onOpenMemory(entry.id)}
              onDelete={() => handleDelete(entry.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );

  if (split) {
    return <KnowledgeSplit list={list} detail={openView} emptyLabel={t('rightSidebar.contextNotesTodo.memory.selectHint')} />;
  }
  return openView ?? list;
};
