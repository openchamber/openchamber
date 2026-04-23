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

type PromptBlock = {
  id: MagicPromptId;
  title: string;
};

type PromptPageConfig = {
  title: string;
  description: string;
  blocks: PromptBlock[];
};

const PROMPT_PAGE_MAP: Record<string, PromptPageConfig> = {
  'git.commit.generate': {
    title: 'Commit Generation',
    description: 'Prompts used for commit message generation: visible user message + hidden instructions.',
    blocks: [
      { id: 'git.commit.generate.visible', title: 'Visible Prompt' },
      { id: 'git.commit.generate.instructions', title: 'Instructions' },
    ],
  },
  'git.pr.generate': {
    title: 'PR Generation',
    description: 'Prompts used for PR title/body generation: visible user message + hidden instructions.',
    blocks: [
      { id: 'git.pr.generate.visible', title: 'Visible Prompt' },
      { id: 'git.pr.generate.instructions', title: 'Instructions' },
    ],
  },
  'github.pr.review': {
    title: 'PR Review',
    description: 'Prompts used for PR review flow: visible user message + hidden instruction payload.',
    blocks: [
      { id: 'github.pr.review.visible', title: 'Visible Prompt' },
      { id: 'github.pr.review.instructions', title: 'Instructions' },
    ],
  },
  'github.issue.review': {
    title: 'Issue Review',
    description: 'Prompts used for issue review flow: visible user message + hidden instruction payload.',
    blocks: [
      { id: 'github.issue.review.visible', title: 'Visible Prompt' },
      { id: 'github.issue.review.instructions', title: 'Instructions' },
    ],
  },
  'github.pr.checks.review': {
    title: 'PR Failed Checks Review',
    description: 'Prompts used for PR failed checks analysis.',
    blocks: [
      { id: 'github.pr.checks.review.visible', title: 'Visible Prompt' },
      { id: 'github.pr.checks.review.instructions', title: 'Instructions' },
    ],
  },
  'github.pr.comments.review': {
    title: 'PR Comments Review',
    description: 'Prompts used for PR comments analysis.',
    blocks: [
      { id: 'github.pr.comments.review.visible', title: 'Visible Prompt' },
      { id: 'github.pr.comments.review.instructions', title: 'Instructions' },
    ],
  },
  'github.pr.comment.single': {
    title: 'Single PR Comment Review',
    description: 'Prompts used for single PR comment analysis.',
    blocks: [
      { id: 'github.pr.comment.single.visible', title: 'Visible Prompt' },
      { id: 'github.pr.comment.single.instructions', title: 'Instructions' },
    ],
  },
  'git.conflict.resolve': {
    title: 'Merge/Rebase Conflict Resolution',
    description: 'Prompts used when resolving merge/rebase conflicts with AI.',
    blocks: [
      { id: 'git.conflict.resolve.visible', title: 'Visible Prompt' },
      { id: 'git.conflict.resolve.instructions', title: 'Instructions' },
    ],
  },
  'git.integrate.cherrypick.resolve': {
    title: 'Cherry-pick Conflict Resolution',
    description: 'Prompts used when resolving cherry-pick conflicts in integrate flow.',
    blocks: [
      { id: 'git.integrate.cherrypick.resolve.visible', title: 'Visible Prompt' },
      { id: 'git.integrate.cherrypick.resolve.instructions', title: 'Instructions' },
    ],
  },
  'plan.improve': {
    title: 'Improve Plan',
    description: 'Hidden prompt used when sending a saved plan into an improve flow.',
    blocks: [
      { id: 'plan.improve.visible', title: 'Visible Prompt' },
      { id: 'plan.improve.instructions', title: 'Instructions' },
    ],
  },
  'plan.todo': {
    title: 'Todo Planning',
    description: 'Hidden prompt used when sending a todo into a new planning session.',
    blocks: [
      { id: 'plan.todo.visible', title: 'Visible Prompt' },
      { id: 'plan.todo.instructions', title: 'Instructions' },
    ],
  },
  'plan.implement': {
    title: 'Implement Plan',
    description: 'Hidden prompt used when sending a saved plan into an implement flow.',
    blocks: [
      { id: 'plan.implement.visible', title: 'Visible Prompt' },
      { id: 'plan.implement.instructions', title: 'Instructions' },
    ],
  },
  'session.summary': {
    title: 'Session Summary',
    description: 'Prompts used by the /summary slash command: visible user message + hidden instructions. Non-destructive — does not compact session history.',
    blocks: [
      { id: 'session.summary.visible', title: 'Visible Prompt' },
      { id: 'session.summary.instructions', title: 'Instructions' },
    ],
  },
  'session.review': {
    title: 'Workspace Review',
    description: 'Prompts used by the /review slash command: visible user message + hidden instructions. Reviews current workspace changes for high-signal issues only.',
    blocks: [
      { id: 'session.review.visible', title: 'Visible Prompt' },
      { id: 'session.review.instructions', title: 'Instructions' },
    ],
  },
};

const hasOwn = (input: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(input, key);
const isVisiblePromptId = (id: MagicPromptId): boolean => id.endsWith('.visible');

export const MagicPromptsPage: React.FC = () => {
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
        toast.error('Failed to load Magic Prompts');
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
  }, []);

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
      toast.error('Visible prompt cannot be empty');
      return;
    }
    setSavingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = value === getDefaultMagicPromptTemplate(id)
        ? await resetMagicPromptOverride(id)
        : await saveMagicPromptOverride(id, value);
      setOverrides(payload.overrides);
      toast.success('Magic prompt saved');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to save magic prompt', { description: message });
    } finally {
      setSavingIds((current) => ({ ...current, [id]: false }));
    }
  }, [getDraft]);

  const resetPrompt = React.useCallback(async (id: MagicPromptId) => {
    setResettingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = await resetMagicPromptOverride(id);
      setOverrides(payload.overrides);
      setDrafts((current) => ({
        ...current,
        [id]: getDefaultMagicPromptTemplate(id),
      }));
      toast.success('Prompt reset to default');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to reset prompt', { description: message });
    } finally {
      setResettingIds((current) => ({ ...current, [id]: false }));
    }
  }, []);

  const handleResetAll = React.useCallback(async () => {
    setResettingAll(true);
    try {
      const payload = await resetAllMagicPromptOverrides();
      setOverrides(payload.overrides);
      setDrafts({});
      toast.success('All prompt overrides reset');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to reset all prompts', { description: message });
    } finally {
      setResettingAll(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="py-6 px-6 flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" aria-label="Loading" />
        <span className="typography-ui">Loading Magic Prompts...</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="typography-ui-header font-semibold text-foreground">{pageConfig.title}</h2>
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {pageConfig.description}
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
            {resettingAll ? 'Resetting...' : 'Reset All Overrides'}
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
                  <h3 className="typography-ui-label text-foreground">{block.title}</h3>
                  <Tooltip delayDuration={700}>
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
                    Placeholders: {definition.placeholders.map((item) => `{{${item.key}}}`).join(', ')}
                  </div>
                )}
              </div>

              <Textarea
                value={draft}
                onChange={(event) => setDraft(block.id, event.target.value)}
                className="min-h-[220px] font-mono text-sm"
              />
              {isInvalidEmptyVisiblePrompt && (
                <div className="typography-micro text-[var(--status-error)]">Visible prompt cannot be empty.</div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="typography-micro text-muted-foreground">
                  {isDirty ? 'Unsaved changes' : isOverridden ? 'Using saved override' : 'Using built-in default'}
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
                    {resetting ? 'Resetting...' : 'Reset to Default'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      void savePrompt(block.id);
                    }}
                    disabled={!isDirty || saving || resetting || isInvalidEmptyVisiblePrompt}
                  >
                    {saving ? 'Saving...' : 'Save'}
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
