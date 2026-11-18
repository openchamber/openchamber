import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ApproveAction, IssueProvider } from '@/lib/suggestedTasksApi';
import type { SuggestionDecision } from './SuggestionCard';

const ISSUE_LABEL = {
  github: 'suggestedTasks.action.issueGitHub', gitlab: 'suggestedTasks.action.issueGitLab', linear: 'suggestedTasks.action.issueLinear',
} satisfies Record<IssueProvider, I18nKey>;

export function SuggestionApprovalMenu({ issueProviders, canCreateWorktree, botsAvailable, disabled, onDecide }: {
  readonly issueProviders: readonly IssueProvider[]; readonly canCreateWorktree: boolean; readonly botsAvailable: boolean;
  readonly disabled: boolean; readonly onDecide: (decision: SuggestionDecision) => void;
}) {
  const { t } = useI18n();
  const items: readonly { action: ApproveAction; icon: IconName; label: I18nKey; hidden?: boolean }[] = [
    { action: 'session', icon: 'chat-new', label: 'suggestedTasks.action.session' },
    { action: 'worktree', icon: 'git-branch', label: 'suggestedTasks.action.worktree', hidden: !canCreateWorktree },
    { action: 'draft-pr', icon: 'git-pull-request', label: 'suggestedTasks.action.draftPr', hidden: !canCreateWorktree },
    { action: 'draft', icon: 'edit-2', label: 'suggestedTasks.action.draft' },
    { action: 'todo', icon: 'todo', label: 'suggestedTasks.action.todo' },
  ];
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant="outline" disabled={disabled}>
        {t('suggestedTasks.action.approveAs')}<Icon name="arrow-down-s" className="size-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-56">
      {items.filter((item) => !item.hidden).map((item) => <DropdownMenuItem key={item.action} disabled={disabled} onClick={() => onDecide({ kind: 'approve', action: item.action })}>
        <Icon name={item.icon} className="size-4" />{t(item.label)}
      </DropdownMenuItem>)}
      {botsAvailable ? <DropdownMenuItem disabled={disabled} onClick={() => onDecide({ kind: 'handoff-bot' })}>
        <Icon name="ai-agent" className="size-4" />{t('suggestedTasks.action.bot')}
      </DropdownMenuItem> : null}
      {issueProviders.length ? <>
        <DropdownMenuSeparator /><DropdownMenuLabel>{t('suggestedTasks.action.issueGroup')}</DropdownMenuLabel>
        {issueProviders.map((provider) => <DropdownMenuItem key={provider} disabled={disabled} onClick={() => onDecide({ kind: 'approve', action: 'issue', provider })}>
          <Icon name="external-link" className="size-4" />{t(ISSUE_LABEL[provider])}
        </DropdownMenuItem>)}
      </> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
