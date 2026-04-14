import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';

interface MagicPromptsSidebarProps {
  onItemSelect?: () => void;
}

export const MagicPromptsSidebar: React.FC<MagicPromptsSidebarProps> = ({ onItemSelect }) => {
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const setSelectedPromptId = useMagicPromptsStore((state) => state.setSelectedPromptId);

  const grouped = React.useMemo(() => {
    return [
      {
        group: 'Git',
        items: [
          { id: 'git.commit.generate', title: 'Commit Generation' },
          { id: 'git.pr.generate', title: 'PR Generation' },
          { id: 'git.conflict.resolve', title: 'Merge/Rebase Conflict Resolution' },
          { id: 'git.integrate.cherrypick.resolve', title: 'Cherry-pick Conflict Resolution' },
        ],
      },
      {
        group: 'GitHub',
        items: [
          { id: 'github.pr.review', title: 'PR Review' },
          { id: 'github.issue.review', title: 'Issue Review' },
          { id: 'github.pr.checks.review', title: 'PR Failed Checks Review' },
          { id: 'github.pr.comments.review', title: 'PR Comments Review' },
          { id: 'github.pr.comment.single', title: 'Single PR Comment Review' },
        ],
      },
    ] as const;
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground">{m.magicPromptsTitle()}</h2>
        <p className="typography-meta mt-1 text-muted-foreground">{m.magicPromptsSelect()}</p>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-3 px-3 py-2 overflow-x-hidden">
        {grouped.map((group) => (
          <div key={group.group} className="space-y-1">
            <div className="typography-micro px-1 text-muted-foreground">{group.group}</div>
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
                  <span className="typography-ui-label truncate font-normal">{item.title}</span>
                </button>
              );
            })}
          </div>
        ))}
      </ScrollableOverlay>
    </div>
  );
};
