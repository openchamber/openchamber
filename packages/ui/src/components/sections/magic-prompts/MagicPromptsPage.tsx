import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import {
  fetchMagicPromptOverrides,
  fetchMagicPromptScopes,
  getDefaultMagicPromptTemplate,
  getMagicPromptDefinition,
  resetAllMagicPromptOverrides,
  resetAllScopedMagicPromptOverrides,
  resetMagicPromptOverride,
  resetScopedMagicPromptOverride,
  resolveMagicPromptTemplate,
  saveMagicPromptOverride,
  saveScopedMagicPromptOverride,
  type MagicPromptId,
  type MagicPromptScopesView,
} from '@/lib/magicPrompts';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { ProjectLabel } from '@/components/chat/composer/ui/DraftTargetSelectors';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsChipGroup,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';

type PromptBlock = {
  id: MagicPromptId;
  titleKey: string;
};

type PromptPageConfig = {
  titleKey: string;
  descriptionKey: string;
  blocks: PromptBlock[];
};

const PROMPT_PAGE_MAP: Record<string, PromptPageConfig> = {
  'git.commit.generate': {
    titleKey: 'settings.magicPrompts.page.group.gitCommitGenerate.title',
    descriptionKey: 'settings.magicPrompts.page.group.gitCommitGenerate.description',
    blocks: [
      { id: 'git.commit.generate.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'git.commit.generate.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'git.pr.generate': {
    titleKey: 'settings.magicPrompts.page.group.gitPrGenerate.title',
    descriptionKey: 'settings.magicPrompts.page.group.gitPrGenerate.description',
    blocks: [
      { id: 'git.pr.generate.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'git.pr.generate.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'git.conflict.resolve': {
    titleKey: 'settings.magicPrompts.page.group.gitConflictResolve.title',
    descriptionKey: 'settings.magicPrompts.page.group.gitConflictResolve.description',
    blocks: [
      { id: 'git.conflict.resolve.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'git.conflict.resolve.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'git.integrate.cherrypick.resolve': {
    titleKey: 'settings.magicPrompts.page.group.gitCherrypickConflictResolve.title',
    descriptionKey: 'settings.magicPrompts.page.group.gitCherrypickConflictResolve.description',
    blocks: [
      { id: 'git.integrate.cherrypick.resolve.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'git.integrate.cherrypick.resolve.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'plan.improve': {
    titleKey: 'settings.magicPrompts.page.group.planImprove.title',
    descriptionKey: 'settings.magicPrompts.page.group.planImprove.description',
    blocks: [
      { id: 'plan.improve.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'plan.improve.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'plan.todo': {
    titleKey: 'settings.magicPrompts.page.group.planTodo.title',
    descriptionKey: 'settings.magicPrompts.page.group.planTodo.description',
    blocks: [
      { id: 'plan.todo.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'plan.todo.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'plan.implement': {
    titleKey: 'settings.magicPrompts.page.group.planImplement.title',
    descriptionKey: 'settings.magicPrompts.page.group.planImplement.description',
    blocks: [
      { id: 'plan.implement.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'plan.implement.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.summary': {
    titleKey: 'settings.magicPrompts.page.group.sessionSummary.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionSummary.description',
    blocks: [
      { id: 'session.summary.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.summary.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.review': {
    titleKey: 'settings.magicPrompts.page.group.sessionWorkspaceReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionWorkspaceReview.description',
    blocks: [
      { id: 'session.review.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.review.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.plan': {
    titleKey: 'settings.magicPrompts.page.group.sessionFeaturePlan.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionFeaturePlan.description',
    blocks: [
      { id: 'session.plan.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.plan.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.craftGoal': {
    titleKey: 'settings.magicPrompts.page.group.sessionCraftGoal.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionCraftGoal.description',
    blocks: [
      { id: 'session.craftGoal.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.craftGoal.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.catchup': {
    titleKey: 'settings.magicPrompts.page.group.sessionCatchUp.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionCatchUp.description',
    blocks: [
      { id: 'session.catchup.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.catchup.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.debug': {
    titleKey: 'settings.magicPrompts.page.group.sessionDebug.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionDebug.description',
    blocks: [
      { id: 'session.debug.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.debug.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.weigh': {
    titleKey: 'settings.magicPrompts.page.group.sessionWeigh.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionWeigh.description',
    blocks: [
      { id: 'session.weigh.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.weigh.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.explore': {
    titleKey: 'settings.magicPrompts.page.group.sessionExplore.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionExplore.description',
    blocks: [
      { id: 'session.explore.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.explore.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'session.fusion': {
    titleKey: 'settings.magicPrompts.page.group.sessionFusion.title',
    descriptionKey: 'settings.magicPrompts.page.group.sessionFusion.description',
    blocks: [
      { id: 'session.fusion.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.fusion.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
      { id: 'session.fusion.codeInstructions', titleKey: 'settings.magicPrompts.page.block.codeFusionInstructions' },
    ],
  },
  'memory.tidy': {
    titleKey: 'settings.magicPrompts.page.group.memoryTidy.title',
    descriptionKey: 'settings.magicPrompts.page.group.memoryTidy.description',
    blocks: [
      { id: 'memory.tidy.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'memory.tidy.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
};

const isVisiblePromptId = (id: MagicPromptId): boolean => id.endsWith('.visible');

type Scope = 'global' | 'project';
type Overrides = ReadonlyMap<string, string>;

/**
 * One place the page reads and writes: a scope on one runtime, and for the
 * project scope one registered project. Drafts, pending work and read results
 * are kept per context, so nothing typed or answered in one shows in another.
 */
type EditorContext =
  | { key: string; runtimeKey: string; scope: 'global' }
  | { key: string; runtimeKey: string; scope: 'project'; projectId: string };

/**
 * What a context last read. The global scope reads the global file alone, so
 * it works without a project and whatever state a project file is in. The
 * project scope reads both scopes in one answer, so its inherited text and its
 * overrides come from the same read.
 */
type ContextData =
  | { scope: 'global'; global: Overrides }
  | { scope: 'project'; view: MagicPromptScopesView };

type ContextLoad =
  | { status: 'loading' }
  | { status: 'failed'; reason: string }
  | { status: 'ready'; data: ContextData };

const LOADING: ContextLoad = { status: 'loading' };

type Editable =
  | { kind: 'editable'; scopeOverrides: Overrides; layers: { project: Overrides | null; global: Overrides } }
  | { kind: 'blocked'; error: 'projectInvalid' | 'globalInvalid'; reason: string; path: string };

/**
 * The one write a context may have in flight. Each answer is a whole view of
 * the scope, so two overlapping writes could land in the wrong order and show
 * the older view; a context therefore runs its writes one at a time.
 */
type ContextWrite =
  | { kind: 'save' | 'reset'; id: MagicPromptId }
  | { kind: 'resetAll' };

type PerPrompt<V> = ReadonlyMap<string, ReadonlyMap<MagicPromptId, V>>;

const toOverrides = (record: Record<string, string>): Overrides => new Map(Object.entries(record));

const withEntry = <V,>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => {
  const next = new Map(map);
  next.set(key, value);
  return next;
};

/** Sets one prompt's value in one context; `undefined` removes it. */
const withPromptValue = <V,>(map: PerPrompt<V>, contextKey: string, id: MagicPromptId, value: V | undefined): PerPrompt<V> => {
  const inner = new Map(map.get(contextKey));
  if (value === undefined) inner.delete(id);
  else inner.set(id, value);
  const next = new Map(map);
  if (inner.size === 0) next.delete(contextKey);
  else next.set(contextKey, inner);
  return next;
};

const editableOf = (data: ContextData): Editable => {
  if (data.scope === 'global') {
    return { kind: 'editable', scopeOverrides: data.global, layers: { project: null, global: data.global } };
  }
  const { project, global } = data.view.scopes;
  const path = `${data.view.project.path}/${data.view.project.file}`;
  if (project.status === 'invalid') {
    return { kind: 'blocked', error: 'projectInvalid', reason: project.reason, path };
  }
  // Without the global layer the inherited text is unknown, and showing the
  // built-in text in its place would be wrong.
  if (global.status === 'invalid') {
    return { kind: 'blocked', error: 'globalInvalid', reason: global.reason, path };
  }
  return { kind: 'editable', scopeOverrides: project.overrides, layers: { project: project.overrides, global: global.overrides } };
};

const readContext = async (context: EditorContext): Promise<ContextData> => (
  context.scope === 'project'
    ? { scope: 'project', view: await fetchMagicPromptScopes(context.projectId) }
    : { scope: 'global', global: toOverrides(await fetchMagicPromptOverrides()) }
);

const saveInContext = async (context: EditorContext, id: MagicPromptId, text: string): Promise<ContextData> => {
  if (context.scope === 'project') {
    // Kept even when it equals the built-in text: it still wins over a global override.
    return { scope: 'project', view: await saveScopedMagicPromptOverride({ scope: 'project', projectId: context.projectId }, id, text, context.runtimeKey) };
  }
  const payload = text === getDefaultMagicPromptTemplate(id)
    ? await resetMagicPromptOverride(id, context.runtimeKey)
    : await saveMagicPromptOverride(id, text, context.runtimeKey);
  return { scope: 'global', global: toOverrides(payload.overrides) };
};

const resetInContext = async (context: EditorContext, id: MagicPromptId): Promise<ContextData> => (
  context.scope === 'project'
    ? { scope: 'project', view: await resetScopedMagicPromptOverride({ scope: 'project', projectId: context.projectId }, id, context.runtimeKey) }
    : { scope: 'global', global: toOverrides((await resetMagicPromptOverride(id, context.runtimeKey)).overrides) }
);

const resetAllInContext = async (context: EditorContext): Promise<ContextData> => (
  context.scope === 'project'
    ? { scope: 'project', view: await resetAllScopedMagicPromptOverrides({ scope: 'project', projectId: context.projectId }, context.runtimeKey) }
    : { scope: 'global', global: toOverrides((await resetAllMagicPromptOverrides(context.runtimeKey)).overrides) }
);

const useRuntimeKey = (): string => React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);

// Only the waiting indicator follows the shared clock; the editor state stays still.
const MagicPromptsLoading: React.FC = () => {
  const { t } = useI18n();
  const blink = useWaitingBlink(true);
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full bg-current', blink)} aria-label={t('settings.magicPrompts.page.loading.aria')} />
      <span className="typography-ui">{t('settings.magicPrompts.page.loading.text')}</span>
    </div>
  );
};

export const MagicPromptsPage: React.FC = () => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const { currentTheme } = useThemeSystem();
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const runtimeKey = useRuntimeKey();
  // The Settings project selector decides the project; the chat's active
  // project only stands in until the user picks one there.
  const settingsDirectory = useSettingsDirectory();
  const projects = useProjectsStore((state) => state.projects);
  const project = React.useMemo(
    () => projects.find((entry) => entry.path === settingsDirectory) ?? null,
    [projects, settingsDirectory],
  );
  const projectId = project?.id ?? null;
  const [scope, setScope] = React.useState<Scope>('global');
  const [loads, setLoads] = React.useState<ReadonlyMap<string, ContextLoad>>(() => new Map());
  const [drafts, setDrafts] = React.useState<PerPrompt<string>>(() => new Map());
  const [writes, setWrites] = React.useState<ReadonlyMap<string, ContextWrite>>(() => new Map());
  // The same writes, readable synchronously: a second click before the next
  // render must still find the context busy.
  const writesRef = React.useRef(new Map<string, ContextWrite>());

  // Per context: the latest read, and how many mutations have started. A read
  // that is not the latest, or that started before a mutation, would replace
  // newer data, so its answer is dropped.
  const countersRef = React.useRef(new Map<string, { read: number; mutations: number }>());
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const countersOf = React.useCallback((key: string) => {
    const existing = countersRef.current.get(key);
    if (existing) return existing;
    const created = { read: 0, mutations: 0 };
    countersRef.current.set(key, created);
    return created;
  }, []);

  const context = React.useMemo<EditorContext | null>(() => {
    if (scope === 'global') {
      return { key: JSON.stringify([runtimeKey, 'global']), runtimeKey, scope: 'global' };
    }
    if (!projectId) return null;
    return { key: JSON.stringify([runtimeKey, 'project', projectId]), runtimeKey, scope: 'project', projectId };
  }, [projectId, runtimeKey, scope]);

  const isLive = React.useCallback((target: EditorContext) => (
    mountedRef.current && getRuntimeKey() === target.runtimeKey
  ), []);

  const load = React.useCallback(async (target: EditorContext) => {
    const counters = countersOf(target.key);
    const read = ++counters.read;
    const mutationsAtStart = counters.mutations;
    // A context read before keeps showing while it is read again.
    setLoads((current) => (current.get(target.key)?.status === 'ready' ? current : withEntry(current, target.key, { status: 'loading' })));
    const superseded = () => !isLive(target) || counters.read !== read || counters.mutations !== mutationsAtStart;
    try {
      const data = await readContext(target);
      if (superseded()) return;
      setLoads((current) => withEntry(current, target.key, { status: 'ready', data }));
    } catch (error) {
      if (superseded()) return;
      setLoads((current) => withEntry(current, target.key, { status: 'failed', reason: error instanceof Error ? error.message : String(error) }));
    }
  }, [countersOf, isLive]);

  // Every time a context opens it is read again, so edits made elsewhere show.
  React.useEffect(() => {
    if (context) void load(context);
  }, [context, load]);

  const applyMutation = React.useCallback((target: EditorContext, data: ContextData) => {
    if (!isLive(target)) return;
    setLoads((current) => withEntry(current, target.key, { status: 'ready', data }));
  }, [isLive]);

  const setDraft = React.useCallback((target: EditorContext, id: MagicPromptId, value: string) => {
    setDrafts((current) => (current.get(target.key)?.get(id) === value ? current : withPromptValue(current, target.key, id, value)));
  }, []);

  /** Drops a draft only while it still holds `expected`, so typing during a request survives it. */
  const clearDraftIf = React.useCallback((target: EditorContext, id: MagicPromptId, expected: string | undefined) => {
    setDrafts((current) => (current.get(target.key)?.get(id) === expected ? withPromptValue(current, target.key, id, undefined) : current));
  }, []);

  /**
   * Runs one write of a context, or nothing when that context already has one
   * in flight. Its answer replaces the context's view; a read that started
   * before it is dropped. After a failure the server state is unknown and a
   * dropped read may be gone, so the context is read again.
   */
  const runWrite = React.useCallback(async (
    target: EditorContext,
    write: ContextWrite,
    request: () => Promise<ContextData>,
    onSuccess: () => void,
    failureKey: 'settings.magicPrompts.page.toast.saveFailed' | 'settings.magicPrompts.page.toast.resetFailed' | 'settings.magicPrompts.page.toast.resetAllFailed',
  ) => {
    if (writesRef.current.has(target.key)) return;
    writesRef.current.set(target.key, write);
    setWrites(new Map(writesRef.current));
    countersOf(target.key).mutations += 1;
    try {
      const data = await request();
      applyMutation(target, data);
      if (mountedRef.current) onSuccess();
    } catch (error) {
      if (!mountedRef.current) return;
      toast.error(t(failureKey), { description: error instanceof Error ? error.message : String(error) });
      if (isLive(target)) void load(target);
    } finally {
      writesRef.current.delete(target.key);
      if (mountedRef.current) setWrites(new Map(writesRef.current));
    }
  }, [applyMutation, countersOf, isLive, load, t]);

  const savePrompt = React.useCallback((target: EditorContext, id: MagicPromptId, value: string) => {
    if (isVisiblePromptId(id) && value.trim().length === 0) {
      toast.error(t('settings.magicPrompts.page.toast.visiblePromptRequired'));
      return;
    }
    void runWrite(target, { kind: 'save', id }, () => saveInContext(target, id, value), () => {
      clearDraftIf(target, id, value);
      toast.success(t('settings.magicPrompts.page.toast.saved'));
    }, 'settings.magicPrompts.page.toast.saveFailed');
  }, [clearDraftIf, runWrite, t]);

  const resetPrompt = React.useCallback((target: EditorContext, id: MagicPromptId) => {
    const draftAtStart = drafts.get(target.key)?.get(id);
    void runWrite(target, { kind: 'reset', id }, () => resetInContext(target, id), () => {
      clearDraftIf(target, id, draftAtStart);
      toast.success(t(target.scope === 'project'
        ? 'settings.magicPrompts.page.toast.projectOverrideRemoved'
        : 'settings.magicPrompts.page.toast.resetSuccess'));
    }, 'settings.magicPrompts.page.toast.resetFailed');
  }, [clearDraftIf, drafts, runWrite, t]);

  const resetAll = React.useCallback((target: EditorContext) => {
    const draftsAtStart = drafts.get(target.key) ?? new Map<MagicPromptId, string>();
    void runWrite(target, { kind: 'resetAll' }, () => resetAllInContext(target), () => {
      for (const [id, value] of draftsAtStart) clearDraftIf(target, id, value);
      toast.success(t(target.scope === 'project'
        ? 'settings.magicPrompts.page.toast.projectOverridesRemoved'
        : 'settings.magicPrompts.page.toast.resetAllSuccess'));
    }, 'settings.magicPrompts.page.toast.resetAllFailed');
  }, [clearDraftIf, drafts, runWrite, t]);

  const pageConfig = PROMPT_PAGE_MAP[selectedPromptId] ?? PROMPT_PAGE_MAP['git.commit.generate'];
  const contextLoad = context ? loads.get(context.key) ?? LOADING : null;
  const editable = contextLoad?.status === 'ready' ? editableOf(contextLoad.data) : null;
  const contextWrite = context ? writes.get(context.key) : undefined;
  const isResettingAll = contextWrite?.kind === 'resetAll';
  const canResetAll = context !== null && editable?.kind === 'editable' && editable.scopeOverrides.size > 0 && !contextWrite;

  const projectFilePath = contextLoad?.status === 'ready' && contextLoad.data.scope === 'project'
    ? `${contextLoad.data.view.project.path}/${contextLoad.data.view.project.file}`
    : project?.path ?? '';

  // One line under the scope choice: what the scope covers, which file a
  // project override lives in, or why there is no project scope.
  const scopeHint = !project
    ? t('settings.magicPrompts.page.scope.noProject')
    : scope === 'global'
      ? t('settings.magicPrompts.page.scope.globalHint')
      : (
        <span className="flex min-w-0 items-center gap-1.5" title={projectFilePath}>
          <span className="min-w-0 shrink-0 text-foreground"><ProjectLabel project={project} theme={currentTheme} /></span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{t('settings.magicPrompts.page.scope.savedInLabel')}</span>
          {/* A path reads left to right in every language, so it is its own isolated run. */}
          <span dir="ltr" className="min-w-0 truncate" data-magic-prompt-path>{projectFilePath}</span>
        </span>
      );

  const renderError = (target: EditorContext, message: string, path?: string) => (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--status-error-background)] px-4 py-3">
      <div className="min-w-0 flex-1 basis-64 space-y-1 typography-meta text-[var(--status-error)]">
        <p>{message}</p>
        {path ? <p dir="ltr" className="break-all" data-magic-prompt-path>{path}</p> : null}
      </div>
      <Button variant="outline" size="sm" onClick={() => { void load(target); }}>
        {t('settings.magicPrompts.page.actions.retry')}
      </Button>
    </div>
  );

  const renderBody = () => {
    if (!context) {
      return null;
    }
    if (!contextLoad || contextLoad.status === 'loading') {
      return (
        <MagicPromptsLoading />
      );
    }
    if (contextLoad.status === 'failed') {
      return renderError(context, t('settings.magicPrompts.page.error.loadFailed', { reason: contextLoad.reason }));
    }
    if (editable?.kind === 'blocked') {
      return editable.error === 'projectInvalid'
        ? renderError(context, t('settings.magicPrompts.page.error.projectInvalid', { reason: editable.reason }), editable.path)
        : renderError(context, t('settings.magicPrompts.page.error.globalInvalid', { reason: editable.reason }));
    }
    if (editable?.kind !== 'editable') {
      return null;
    }

    return pageConfig.blocks.map((block) => {
      const definition = getMagicPromptDefinition(block.id);
      const resolved = resolveMagicPromptTemplate(editable.layers, block.id);
      const baseline = resolved.template;
      const draft = drafts.get(context.key)?.get(block.id) ?? baseline;
      const isOverridden = editable.scopeOverrides.has(block.id);
      const isDirty = draft !== baseline;
      const isInvalidEmptyVisiblePrompt = isVisiblePromptId(block.id) && draft.trim().length === 0;
      const ownWrite = contextWrite && contextWrite.kind !== 'resetAll' && contextWrite.id === block.id ? contextWrite.kind : null;
      const saving = ownWrite === 'save';
      const resetting = ownWrite === 'reset';
      // Every write of this context waits for the one in flight.
      const busy = contextWrite !== undefined;
      const status = isDirty
        ? t('settings.magicPrompts.page.status.unsavedChanges')
        : resolved.source === 'project'
          ? t('settings.magicPrompts.page.status.usingProjectOverride')
          : resolved.source === 'global'
            ? t(context.scope === 'project'
              ? 'settings.magicPrompts.page.status.inheritedFromGlobal'
              : 'settings.magicPrompts.page.status.usingGlobalOverride')
            : t('settings.magicPrompts.page.status.usingBuiltinDefault');

      return (
        <SettingsSection
          key={block.id}
          title={tUnsafe(block.titleKey)}
          info={definition.description}
          description={
            definition.placeholders && definition.placeholders.length > 0
              ? `${t('settings.magicPrompts.page.placeholdersLabel')} ${definition.placeholders.map((item) => `{{${item.key}}}`).join(', ')}`
              : undefined
          }
          settingsItem={isVisiblePromptId(block.id) ? 'magic-prompts.visible-prompt' : 'magic-prompts.instructions'}
          contentClassName="space-y-3"
        >
          <Textarea
            aria-label={tUnsafe(block.titleKey)}
            value={draft}
            onChange={(event) => setDraft(context, block.id, event.target.value)}
            className="min-h-[220px] font-mono text-sm"
          />
          {isInvalidEmptyVisiblePrompt && (
            <div className="typography-micro text-[var(--status-error)]">{t('settings.magicPrompts.page.validation.visiblePromptRequired')}</div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="typography-micro text-muted-foreground" data-magic-prompt-status>{status}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => resetPrompt(context, block.id)}
                disabled={!isOverridden || busy}
              >
                {resetting
                  ? t('settings.magicPrompts.page.actions.resetting')
                  : t(context.scope === 'project'
                    ? 'settings.magicPrompts.page.actions.removeProjectOverride'
                    : 'settings.magicPrompts.page.actions.resetToDefault')}
              </Button>
              <Button
                size="sm"
                onClick={() => savePrompt(context, block.id, draft)}
                disabled={!isDirty || busy || isInvalidEmptyVisiblePrompt}
              >
                {saving ? t('settings.common.actions.saving') : t('settings.magicPrompts.page.actions.save')}
              </Button>
            </div>
          </div>
        </SettingsSection>
      );
    });
  };

  return (
    <SettingsPageLayout
      title={tUnsafe(pageConfig.titleKey)}
      titleAccessory={(
        <SettingsInfoHint contentClassName="max-w-xs">{tUnsafe(pageConfig.descriptionKey)}</SettingsInfoHint>
      )}
      headerEnd={(
        <Button
          data-settings-item="magic-prompts.reset-overrides"
          variant="outline"
          size="sm"
          onClick={() => {
            if (context) resetAll(context);
          }}
          disabled={!canResetAll}
        >
          {isResettingAll
            ? t('settings.magicPrompts.page.actions.resetting')
            : t(scope === 'project'
              ? 'settings.magicPrompts.page.actions.resetAllProjectOverrides'
              : 'settings.magicPrompts.page.actions.resetAllOverrides')}
        </Button>
      )}
      showSaveStatus={false}
    >
      <SettingsSection divider={false}>
        <SettingsStackedField
          label={t('settings.magicPrompts.page.scope.label')}
          info={t('settings.magicPrompts.page.scope.info')}
          description={scopeHint}
          descriptionPlacement="after"
          settingsItem="magic-prompts.scope"
        >
          <SettingsChipGroup
            aria-label={t('settings.magicPrompts.page.scope.label')}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'global', label: t('settings.common.scope.global') },
              {
                value: 'project',
                label: t('settings.common.scope.project'),
                disabled: !project && scope !== 'project',
              },
            ]}
          />
        </SettingsStackedField>
      </SettingsSection>
      {renderBody()}
    </SettingsPageLayout>
  );
};
