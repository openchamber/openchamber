import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import type { PendingDiffScope } from '@/stores/useUIStore';

interface ChangeScopeSelectorProps {
    scope: PendingDiffScope;
    historicalTurn?: { count: number | null } | null;
    workingCount: number;
    stagedCount: number;
    turnCount: number | null;
    branchCount: number | null;
    commitCount: number | null;
    prCount: number | null;
    showCommitOption: boolean;
    showBranchOption: boolean;
    hideStagedOption?: boolean;
    changeRequestTerm: ChangeRequestTerm;
    onScopeChange?: (scope: PendingDiffScope) => void;
}

export const ChangeScopeSelector = React.memo<ChangeScopeSelectorProps>(({
    scope,
    historicalTurn = null,
    workingCount,
    stagedCount,
    turnCount,
    branchCount,
    commitCount,
    prCount,
    showCommitOption,
    showBranchOption,
    hideStagedOption = false,
    changeRequestTerm,
    onScopeChange,
}) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const showsHistoricalTurn = scope === 'turn' && historicalTurn !== null;
    const currentCount = scope === 'pr' ? prCount : scope === 'staged' ? stagedCount : scope === 'turn' ? (historicalTurn ? historicalTurn.count : turnCount) : scope === 'branch' ? branchCount : scope === 'commit' ? commitCount : workingCount;
    const currentLabel = scope === 'pr' ? t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', changeRequestTerm)) : scope === 'staged'
        ? t('diffView.scope.staged')
        : scope === 'turn'
            ? (showsHistoricalTurn ? t('diffView.scope.earlierTurn') : t('diffView.scope.lastTurn'))
            : scope === 'branch'
                ? t('diffView.scope.branch')
                : scope === 'commit' ? t('commitComparison.mode') : t('diffView.scope.changed');

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <HoverTooltip label={t('contextTooltips.diff.scope')} side="bottom">
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 typography-ui-label font-semibold text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t('diffView.scope.selectorAria')}
                    >
                        <span className="change-scope__label min-w-0 truncate whitespace-nowrap">
                            {currentLabel}{currentCount !== null && <span className="diff-toolbar__scope-count">: {currentCount}</span>}
                        </span>
                        <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
                    </button>
                </DropdownMenuTrigger>
            </HoverTooltip>
            <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuRadioGroup
                    value={showsHistoricalTurn ? 'historical-turn' : scope}
                    onValueChange={(value) => {
                        if (value === 'working' || value === 'staged' || value === 'turn' || value === 'branch' || value === 'commit' || value === 'pr') {
                            onScopeChange?.(value);
                            setOpen(false);
                        }
                    }}
                >
                    {showsHistoricalTurn && (
                        <DropdownMenuRadioItem value="historical-turn">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('diffView.scope.earlierTurn')}</span>
                                <span className="typography-meta text-muted-foreground">{historicalTurn?.count ?? '…'}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    )}
                    <DropdownMenuRadioItem value="turn">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.lastTurn')}</span>
                            <span className="typography-meta text-muted-foreground">{turnCount ?? '…'}</span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="working">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.changed')}</span>
                            <span className="typography-meta text-muted-foreground">{workingCount}</span>
                        </span>
                    </DropdownMenuRadioItem>
                    {!hideStagedOption && (
                        <DropdownMenuRadioItem value="staged">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('diffView.scope.staged')}</span>
                                <span className="typography-meta text-muted-foreground">{stagedCount}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    )}
                    {showCommitOption && (
                        <DropdownMenuRadioItem value="commit">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('commitComparison.mode')}</span>
                                <span className="typography-meta text-muted-foreground">{commitCount ?? '…'}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    )}
                    {showBranchOption ? (
                        <DropdownMenuRadioItem value="branch">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('diffView.scope.branch')}</span>
                                <span className="typography-meta text-muted-foreground">{branchCount ?? '…'}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    ) : null}
                    {showCommitOption && <DropdownMenuRadioItem value="pr">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', changeRequestTerm))}</span>
                            <span className="typography-meta text-muted-foreground">{prCount ?? '…'}</span>
                        </span>
                    </DropdownMenuRadioItem>}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
});
