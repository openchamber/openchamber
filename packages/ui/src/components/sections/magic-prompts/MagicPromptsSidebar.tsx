import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface MagicPromptsSidebarProps {
  onItemSelect?: () => void;
}

export const MagicPromptsSidebar: React.FC<MagicPromptsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const setSelectedPromptId = useMagicPromptsStore((state) => state.setSelectedPromptId);

  const grouped = React.useMemo(() => {
    return [
      {
        groupKey: 'settings.magicPrompts.sidebar.group.git',
        items: [
          { id: 'git.commit.generate', titleKey: 'settings.magicPrompts.sidebar.item.gitCommitGenerate' },
          { id: 'git.pr.generate', titleKey: 'settings.magicPrompts.sidebar.item.gitPrGenerate' },
          { id: 'git.conflict.resolve', titleKey: 'settings.magicPrompts.sidebar.item.gitConflictResolve' },
          { id: 'git.integrate.cherrypick.resolve', titleKey: 'settings.magicPrompts.sidebar.item.gitCherrypickConflictResolve' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.github',
        items: [
          { id: 'github.pr.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrReview' },
          { id: 'github.issue.review', titleKey: 'settings.magicPrompts.sidebar.item.githubIssueReview' },
          { id: 'github.pr.checks.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrFailedChecksReview' },
          { id: 'github.pr.comments.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrCommentsReview' },
          { id: 'github.pr.comment.single', titleKey: 'settings.magicPrompts.sidebar.item.githubSinglePrCommentReview' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.planning',
        items: [
          { id: 'plan.todo', titleKey: 'settings.magicPrompts.sidebar.item.planTodo' },
          { id: 'plan.improve', titleKey: 'settings.magicPrompts.sidebar.item.planImprove' },
          { id: 'plan.implement', titleKey: 'settings.magicPrompts.sidebar.item.planImplement' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.session',
        items: [
          { id: 'session.summary', titleKey: 'settings.magicPrompts.sidebar.item.sessionSummary' },
          { id: 'session.review', titleKey: 'settings.magicPrompts.sidebar.item.sessionWorkspaceReview' },
        ],
      },
    ] as const;
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground">{t('settings.magicPrompts.sidebar.title')}</h2>
        <p className="typography-meta mt-1 text-muted-foreground">{t('settings.magicPrompts.sidebar.description')}</p>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-3 px-3 py-2 overflow-x-hidden">
        {grouped.map((group) => (
          <div key={group.groupKey} className="space-y-1">
            <div className="typography-micro px-1 text-muted-foreground">{t(group.groupKey)}</div>
            {group.items.map((item) => {
              const selected = selectedPromptId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedPromptId(item.id);
                    onItemSelect?.();
                  }}
                  className={cn(
                    'flex w-full items-center rounded-md px-2 py-1.5 text-left transition-colors',
                    selected ? 'bg-interactive-selection text-foreground' : 'text-foreground hover:bg-interactive-hover'
                  )}
                >
                  <span className="typography-ui-label truncate font-normal">{t(item.titleKey)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </ScrollableOverlay>
    </div>
  );
};
