import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiInformationLine } from '@remixicon/react';
import {
  fetchMagicPromptOverrides,
  getDefaultMagicPromptTemplate,
  getMagicPromptDefinition,
  resetAllMagicPromptOverrides,
  resetMagicPromptOverride,
  saveMagicPromptOverride,
  type MagicPromptId,
} from '@/lib/magicPrompts';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { useI18n } from '@/lib/i18n';

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
  'github.pr.review': {
    titleKey: 'settings.magicPrompts.page.group.githubPrReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.githubPrReview.description',
    blocks: [
      { id: 'github.pr.review.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'github.pr.review.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'github.issue.review': {
    titleKey: 'settings.magicPrompts.page.group.githubIssueReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.githubIssueReview.description',
    blocks: [
      { id: 'github.issue.review.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'github.issue.review.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'github.pr.checks.review': {
    titleKey: 'settings.magicPrompts.page.group.githubPrFailedChecksReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.githubPrFailedChecksReview.description',
    blocks: [
      { id: 'github.pr.checks.review.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'github.pr.checks.review.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'github.pr.comments.review': {
    titleKey: 'settings.magicPrompts.page.group.githubPrCommentsReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.githubPrCommentsReview.description',
    blocks: [
      { id: 'github.pr.comments.review.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'github.pr.comments.review.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
  'github.pr.comment.single': {
    titleKey: 'settings.magicPrompts.page.group.githubSinglePrCommentReview.title',
    descriptionKey: 'settings.magicPrompts.page.group.githubSinglePrCommentReview.description',
    blocks: [
      { id: 'github.pr.comment.single.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'github.pr.comment.single.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
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
};

const hasOwn = (input: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(input, key);
const isVisiblePromptId = (id: MagicPromptId): boolean => id.endsWith('.visible');

export const MagicPromptsPage: React.FC = () => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const [loading, setLoading] = React.useState(true);
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = React.useState<Record<string, boolean>>({});
  const [resettingIds, setResettingIds] = React.useState<Record<string, boolean>>({});
  const [resettingAll, setResettingAll] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const nextOverrides = await fetchMagicPromptOverrides();
        if (!active) return;
        setOverrides(nextOverrides);
      } catch (error) {
        console.warn('Failed to load magic prompts:', error);
        toast.error(t('settings.magicPrompts.page.toast.loadFailed'));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [t]);

  const pageConfig = PROMPT_PAGE_MAP[selectedPromptId] ?? PROMPT_PAGE_MAP['git.commit.generate'];
  const getBaseline = React.useCallback((id: MagicPromptId) => {
    return hasOwn(overrides, id) ? overrides[id] : getDefaultMagicPromptTemplate(id);
  }, [overrides]);

  const getDraft = React.useCallback((id: MagicPromptId) => {
    return drafts[id] ?? getBaseline(id);
  }, [drafts, getBaseline]);

  const setDraft = React.useCallback((id: MagicPromptId, value: string) => {
    setDrafts((current) => {
      if (current[id] === value) {
        return current;
      }
      return { ...current, [id]: value };
    });
  }, []);

  const savePrompt = React.useCallback(async (id: MagicPromptId) => {
    const value = getDraft(id);
    if (isVisiblePromptId(id) && value.trim().length === 0) {
      toast.error(t('settings.magicPrompts.page.toast.visiblePromptRequired'));
      return;
    }
    setSavingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = value === getDefaultMagicPromptTemplate(id)
        ? await resetMagicPromptOverride(id)
        : await saveMagicPromptOverride(id, value);
      setOverrides(payload.overrides);
      toast.success(t('settings.magicPrompts.page.toast.saved'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('settings.magicPrompts.page.toast.saveFailed'), { description: message });
    } finally {
      setSavingIds((current) => ({ ...current, [id]: false }));
    }
  }, [getDraft, t]);

  const resetPrompt = React.useCallback(async (id: MagicPromptId) => {
    setResettingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = await resetMagicPromptOverride(id);
      setOverrides(payload.overrides);
      setDrafts((current) => ({
        ...current,
        [id]: getDefaultMagicPromptTemplate(id),
      }));
      toast.success(t('settings.magicPrompts.page.toast.resetSuccess'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('settings.magicPrompts.page.toast.resetFailed'), { description: message });
    } finally {
      setResettingIds((current) => ({ ...current, [id]: false }));
    }
  }, [t]);

  const handleResetAll = React.useCallback(async () => {
    setResettingAll(true);
    try {
      const payload = await resetAllMagicPromptOverrides();
      setOverrides(payload.overrides);
      setDrafts({});
      toast.success(t('settings.magicPrompts.page.toast.resetAllSuccess'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('settings.magicPrompts.page.toast.resetAllFailed'), { description: message });
    } finally {
      setResettingAll(false);
    }
  }, [t]);

  if (loading) {
    return (
      <div className="py-6 px-6 flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" aria-label={t('settings.magicPrompts.page.loading.aria')} />
        <span className="typography-ui">{t('settings.magicPrompts.page.loading.text')}</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="typography-ui-header font-semibold text-foreground">{tUnsafe(pageConfig.titleKey)}</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {tUnsafe(pageConfig.descriptionKey)}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleResetAll();
            }}
            disabled={resettingAll || Object.keys(overrides).length === 0}
          >
            {resettingAll ? t('settings.magicPrompts.page.actions.resetting') : t('settings.magicPrompts.page.actions.resetAllOverrides')}
          </Button>
        </div>

        {pageConfig.blocks.map((block, index) => {
          const definition = getMagicPromptDefinition(block.id);
          const baseline = getBaseline(block.id);
          const draft = getDraft(block.id);
          const isOverridden = hasOwn(overrides, block.id);
          const isDirty = draft !== baseline;
          const isInvalidEmptyVisiblePrompt = isVisiblePromptId(block.id) && draft.trim().length === 0;
          const saving = savingIds[block.id] === true;
          const resetting = resettingIds[block.id] === true;

          return (
            <section key={block.id} className={index > 0 ? 'space-y-3 pt-5 border-t border-border' : 'space-y-3'}>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="typography-ui-label text-foreground">{tUnsafe(block.titleKey)}</h3>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {definition.description}
                    </TooltipContent>
                  </Tooltip>
                </div>
                {definition.placeholders && definition.placeholders.length > 0 && (
                  <div className="typography-micro text-muted-foreground">
                    {t('settings.magicPrompts.page.placeholdersLabel')}{' '}
                    {definition.placeholders.map((item) => `{{${item.key}}}`).join(', ')}
                  </div>
                )}
              </div>

              <Textarea
                value={draft}
                onChange={(event) => setDraft(block.id, event.target.value)}
                className="min-h-[220px] font-mono text-sm"
              />
              {isInvalidEmptyVisiblePrompt && (
                <div className="typography-micro text-[var(--status-error)]">{t('settings.magicPrompts.page.validation.visiblePromptRequired')}</div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="typography-micro text-muted-foreground">
                  {isDirty
                    ? t('settings.magicPrompts.page.status.unsavedChanges')
                    : isOverridden
                      ? t('settings.magicPrompts.page.status.usingSavedOverride')
                      : t('settings.magicPrompts.page.status.usingBuiltinDefault')}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void resetPrompt(block.id);
                    }}
                    disabled={!isOverridden || saving || resetting}
                  >
                    {resetting ? t('settings.magicPrompts.page.actions.resetting') : t('settings.magicPrompts.page.actions.resetToDefault')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      void savePrompt(block.id);
                    }}
                    disabled={!isDirty || saving || resetting || isInvalidEmptyVisiblePrompt}
                  >
                    {saving ? t('settings.common.actions.saving') : t('settings.magicPrompts.page.actions.save')}
                  </Button>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
