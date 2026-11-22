/**
 * Where the draft's auto-created worktree starts: the Settings default, a
 * worktree's branch, any other local or remote branch, or a pull request typed
 * by number. The pick is kept on the draft together with the project it was
 * made in, so a draft moved to another project falls back to the default.
 * A picked pull request adds a New branch checkbox: off checks out its branch
 * so commits push to it, on starts a new branch from its head.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRepositoryReadContext } from '@/components/references/referenceSources';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { NewWorktreeBranchPicker, type BranchPickerSection } from '@/components/session/NewWorktreeBranchPicker';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import {
    checkPullRequestSource,
    formatStartRefLabel,
    groupStartSourceBranches,
    pullRequestWorktreeChoices,
    resolveRemoteDefaultStartRef,
    selectWorktreeStartFrom,
    type WorktreeStartSource,
} from '@/lib/worktrees/worktreeStartSource';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGitBranches, useGitLoadingBranches } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';

/** The row that follows the Settings default. A colon cannot occur in a git ref name. */
const DEFAULT_SOURCE_VALUE = ':default';
const EMPTY_WORKTREES: readonly WorktreeMetadata[] = [];

const sourceValue = (source: WorktreeStartSource | null): string => {
    if (!source) return DEFAULT_SOURCE_VALUE;
    return source.kind === 'ref' ? source.ref : `pull-request:${source.number}`;
};

export function AutoWorktreeSourcePicker({ projectId, projectPath, isMobile }: {
    projectId: string;
    projectPath: string;
    isMobile: boolean;
}) {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const directory = normalizePath(projectPath) ?? projectPath;
    const startFrom = useConfigStore((state) => selectWorktreeStartFrom(state, 'autoCreate'));
    const pullRequestMode = useConfigStore((state) => state.settingsPullRequestWorktree);
    const picked = useSessionUIStore((state) => state.newSessionDraft.autoWorktreeSource);
    const setPicked = useSessionUIStore((state) => state.setDraftAutoWorktreeSource);
    const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject.get(directory)
        ?? state.availableWorktreesByProject.get(projectPath)
        ?? EMPTY_WORKTREES);
    const branches = useGitBranches(directory);
    const isLoading = useGitLoadingBranches(directory) && !branches;
    const readContext = useRepositoryReadContext(directory);
    const descriptorOf = useSourceControlDescriptorOf();
    const context: SourceControlReadContext | null = readContext && readContext !== 'missing' ? readContext : null;

    const source = picked?.projectId === projectId ? picked.source : null;
    const rootBranch = branches?.current?.trim() ?? '';
    const defaultRef = startFrom === 'remote-default' && branches ? resolveRemoteDefaultStartRef(branches) : null;
    const defaultLabel = defaultRef ? formatStartRefLabel(defaultRef) : rootBranch || t('chat.chatInput.projectRoot');

    const pullRequestLabel = React.useCallback((number: number) => (
        context && context.provider !== 'github'
            ? formatChangeRequestReference(descriptorOf(context.provider), number)
            : t('session.newWorktree.prNumber', { number })
    ), [context, descriptorOf, t]);

    const groups = React.useMemo(() => groupStartSourceBranches(
        branches?.all ?? [],
        rootBranch,
        worktrees.map((worktree) => worktree.branch?.trim() ?? ''),
    ), [branches?.all, rootBranch, worktrees]);

    const leadingSections = React.useMemo((): BranchPickerSection[] => [
        { heading: t('chat.chatInput.autoWorktree.source.default'), branches: [{ value: DEFAULT_SOURCE_VALUE, label: defaultLabel }] },
        {
            heading: t('chat.chatInput.worktrees'),
            branches: groups.checkedOut.map((branch) => ({
                value: branch,
                label: branch === rootBranch ? `${branch} · ${t('chat.chatInput.projectRoot')}` : branch,
            })),
        },
    ], [defaultLabel, groups.checkedOut, rootBranch, t]);

    // The newest pick wins: a pull request read that finishes after a later
    // pick, or after the draft changed, is dropped.
    const pickSequence = React.useRef(0);
    const pickRef = React.useCallback((value: string) => {
        pickSequence.current += 1;
        setPicked(value === DEFAULT_SOURCE_VALUE ? null : { projectId, source: { kind: 'ref', ref: value } });
    }, [projectId, setPicked]);

    const pickPullRequest = React.useCallback((number: number) => {
        if (!context) return;
        const reference = pullRequestLabel(number);
        const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
        pickSequence.current += 1;
        const sequence = pickSequence.current;
        void (async () => {
            try {
                const check = await checkPullRequestSource({
                    context,
                    number,
                    mode: pullRequestMode,
                    readChangeRequest: async (readContext, readNumber) => (await sourceControl.changeRequestContext(readContext, readNumber, {
                        includeDiff: false,
                        includeCIDetails: false,
                    })).changeRequest,
                    isBranchInUse: async (branch) => (await validateWorktreeCreate(
                        { id: projectId, path: projectPath },
                        { mode: 'new', branchName: branch, worktreeName: branch },
                    )).errors.some((entry) => entry.code === 'branch_in_use'),
                });
                if (pickSequence.current !== sequence) return;
                if (!check.ok) {
                    toast.error(check.reason === 'not-found'
                        ? t('chat.chatInput.autoWorktree.source.notFound', { reference })
                        : check.reason === 'not-open'
                            ? t('chat.chatInput.autoWorktree.source.notOpen', { reference })
                            : t('session.githubIntegration.validation.branchAlreadyCheckedOut'));
                    return;
                }
                if (useSessionUIStore.getState().newSessionDraft.draftId !== draftId) return;
                setPicked({ projectId, source: check.source });
            } catch (error) {
                if (pickSequence.current !== sequence) return;
                toast.error(t('chat.chatInput.autoWorktree.source.readFailed', { reference }), {
                    description: error instanceof Error ? error.message : String(error),
                });
            }
        })();
    }, [context, projectId, projectPath, pullRequestLabel, pullRequestMode, setPicked, sourceControl, t]);

    const pullRequests = React.useMemo(() => (context ? {
        heading: context.provider === 'gitlab'
            ? t('chat.chatInput.autoWorktree.source.mergeRequests')
            : t('chat.chatInput.autoWorktree.source.pullRequests'),
        label: pullRequestLabel,
        onPick: pickPullRequest,
    } : undefined), [context, pickPullRequest, pullRequestLabel, t]);

    const sourceLabel = !source
        ? defaultLabel
        : source.kind === 'ref'
            ? formatStartRefLabel(source.ref)
            : `${pullRequestLabel(source.number)} · ${source.title}`;

    const pullRequestChoices = source?.kind === 'pull-request' ? pullRequestWorktreeChoices(source) : null;

    return (
        <>
            <NewWorktreeBranchPicker
                variant="inline"
                value={sourceValue(source)}
                valueLabel={t('chat.chatInput.autoWorktree.source.trigger', { source: sourceLabel })}
                placeholder={defaultLabel}
                title={t('chat.chatInput.autoWorktree.source.title')}
                localBranches={groups.local}
                remoteBranches={groups.remote}
                leadingSections={leadingSections}
                pullRequests={pullRequests}
                isLoading={isLoading}
                isMobile={isMobile}
                onSelect={(branch) => pickRef(branch.value)}
            />
            {source?.kind === 'pull-request' && pullRequestChoices ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex shrink-0 items-center gap-1.5 typography-ui-label text-muted-foreground">
                            <Checkbox
                                checked={source.branchOff}
                                disabled={!pullRequestChoices.checkOut || !pullRequestChoices.branchOff}
                                onChange={(branchOff) => setPicked({ projectId, source: { ...source, branchOff } })}
                                ariaLabel={t('chat.chatInput.autoWorktree.source.branchOff')}
                            />
                            <span>{t('chat.chatInput.autoWorktree.source.branchOff')}</span>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent showArrow side="top" sideOffset={8} className="max-w-72">
                        {t('chat.chatInput.autoWorktree.source.branchOffTooltip')}
                    </TooltipContent>
                </Tooltip>
            ) : null}
        </>
    );
}
