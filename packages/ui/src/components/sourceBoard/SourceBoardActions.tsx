import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { REFERENCE_META_TEXT, referenceNumberLabel } from '@/components/references/referencePickerItems';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { usePendingComposerReferences } from '@/components/chat/composer/pendingComposerReferences';
import type { ReferencePickerItem, ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { readLinearIssueDetail } from '@/components/references/referenceSources';
import { resolveComposerReferences } from '@/components/references/resolveComposerReferences';
import { readMergeMethod, rememberMergeMethod, type MergeMethod } from '@/components/views/git/mergeMethodPreference';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SetStateInput, SourceControlCapabilities } from '@/lib/source-control/types';
import { formatChangeRequestReference } from '@/lib/source-control/identity';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { newMutationKey } from './mutationKey';

/** A project the board acts in: its id and root folder. */
export type SourceBoardProject = { id: string; path: string };

const MERGE_METHOD_LABELS = {
    squash: 'gitView.pr.mergeMethod.squash',
    merge: 'gitView.pr.mergeMethod.merge',
    rebase: 'gitView.pr.mergeMethod.rebase',
} as const;

const MERGE_METHOD_KEYS = {
    merge: 'sourceBoard.merge.method.merge',
    squash: 'sourceBoard.merge.method.squash',
    rebase: 'sourceBoard.merge.method.rebase',
} as const;

/** What a session started from the item gets: the item itself, as a composer chip. */
const selectionOf = (item: ReferencePickerItem): ReferencePickerSelection => (
    item.source === 'linear' ? item : { source: 'github', reference: item.reference, includeDiff: false }
);

/**
 * The project's capabilities on its host, for merge and ready. Null until
 * they are known or when they cannot be read; the actions stay hidden then.
 */
function useCapabilities(context: SourceControlReadContext | null): SourceControlCapabilities | null {
    const { sourceControl } = useRuntimeAPIs();
    const [state, setState] = React.useState<{ context: SourceControlReadContext; capabilities: SourceControlCapabilities } | null>(null);
    React.useEffect(() => {
        if (!context) return;
        let cancelled = false;
        void sourceControl.capabilities(context)
            .then((capabilities) => { if (!cancelled) setState({ context, capabilities }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [context, sourceControl]);
    return state && state.context === context ? state.capabilities : null;
}

const ActionButton: React.FC<{
    icon: IconName;
    label: string;
    onClick: () => void;
    busy?: boolean;
}> = ({ icon, label, onClick, busy = false }) => (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
        <Icon name={busy ? 'loader-4' : icon} className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {label}
    </Button>
);

/**
 * What the board does with the previewed item: start work on it, or merge
 * a pull request.
 *
 * `project` is where work starts; for a Linear issue the board picks it from
 * the team's mapping. `context` reads and changes the project's repository.
 */
export const SourceBoardActions: React.FC<{
    item: ReferencePickerItem;
    project: SourceBoardProject | null;
    context: SourceControlReadContext | null;
    onStartWorktree: (project: SourceBoardProject, selection: ReferencePickerSelection) => void;
    onChanged: () => void;
    /** Left of the actions: where a Linear issue's session starts, with a way to pick another project. */
    startIn?: React.ReactNode;
    /** The phone shell's page closes once a session starts; the desktop page closes on its own. */
    onLeave?: () => void;
}> = ({ item, project, context, onStartWorktree, onChanged, startIn, onLeave }) => {
    const { t } = useI18n();
    const { sourceControl, linear } = useRuntimeAPIs();
    const confirmation = useConfirmDialog();
    const [busy, setBusy] = React.useState<'merge' | 'ready' | null>(null);

    const pull: GitHubPullReference | null = item.source === 'github' && item.reference.kind === 'pull' ? item.reference : null;
    const openPull = pull && pull.state === 'open' ? pull : null;
    // Asked only while an open PR is previewed: nothing else merges.
    const capabilities = useCapabilities(openPull ? context : null);

    // The open session, when the chat shows one rather than a new-session draft.
    const currentSessionId = useSessionUIStore((state) => (state.newSessionDraft?.open ? null : state.currentSessionId));
    const currentSession = useSession(currentSessionId, currentSessionId ? useSessionUIStore.getState().getDirectoryForSession(currentSessionId) ?? undefined : undefined);

    // The item lands on the composer as a chip, never as a sent message.
    const attachToComposer = () => {
        void resolveComposerReferences([selectionOf(item)], {
            sourceControl,
            context,
            readLinearDetail: (issueId) => (linear
                ? readLinearIssueDetail(linear, issueId)
                : Promise.reject(new Error('Linear is not available here'))),
        }).then(({ references, failures }) => {
            if (references.length > 0) usePendingComposerReferences.getState().push(references);
            const failure = failures[0];
            if (failure) toast.error(t('sourceBoard.error.attachFailed', { item: failure.label }), { description: failure.error });
        });
    };

    const startSession = () => {
        if (!project) return;
        useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        onLeave?.();
        // The draft opens first, so the chip lands on its composer.
        attachToComposer();
    };

    // Back to the chat the board covered; its composer takes the chip.
    const attachToCurrentSession = () => {
        useUIStore.getState().closeMainSurfaces();
        onLeave?.();
        attachToComposer();
    };

    const mergeMethods = capabilities?.mergeChangeRequests ? capabilities.mergeMethods ?? [] : [];
    // The last method chosen anywhere, while this repository allows it.
    const [chosenMethod, setChosenMethod] = React.useState<MergeMethod>(readMergeMethod);
    const mergeMethod = mergeMethods.includes(chosenMethod) ? chosenMethod : mergeMethods[0] ?? null;
    const chooseMergeMethod = (value: string) => {
        const method = mergeMethods.find((candidate) => candidate === value);
        if (!method) return;
        setChosenMethod(method);
        rememberMergeMethod(method);
    };
    const reference = pull ? formatChangeRequestReference(pull.provider ?? 'github', pull.number) : '';

    const merge = async () => {
        if (!openPull || !context || !mergeMethod) return;
        const approved = await confirmation.confirm({
            title: t(context.provider === 'gitlab' ? 'sourceBoard.merge.confirmTitle.gitlab' : 'sourceBoard.merge.confirmTitle.github', { reference }),
            message: t(MERGE_METHOD_KEYS[mergeMethod], { base: openPull.base }),
            action: t('sourceBoard.actions.merge'),
        });
        if (!approved) return;
        setBusy('merge');
        try {
            const receipt = await sourceControl.changeRequestMerge({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: openPull.sourceRepo.owner, name: openPull.sourceRepo.repo }, number: openPull.number, head: openPull.head, base: openPull.base, headSha: openPull.headSha },
                method: mergeMethod,
            });
            if (receipt.result.merged) toast.success(t('sourceBoard.toast.merged', { reference }));
            else toast.message(t('sourceBoard.toast.notMerged', { reference }), { description: receipt.result.message });
        } catch (error) {
            toast.error(t('sourceBoard.toast.mergeFailed', { reference }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
            onChanged();
        }
    };

    const markReady = async () => {
        if (!openPull || !context) return;
        setBusy('ready');
        try {
            await sourceControl.changeRequestReady({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: openPull.sourceRepo.owner, name: openPull.sourceRepo.repo }, number: openPull.number, head: openPull.head, base: openPull.base, headSha: openPull.headSha },
            });
            toast.success(t('sourceBoard.toast.markedReady', { reference }));
        } catch (error) {
            toast.error(t('sourceBoard.toast.markReadyFailed', { reference }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
            onChanged();
        }
    };

    const maintenance = (
        <>
            {openPull && !openPull.draft && mergeMethod ? (
                // One control, as on the host: the button says how it merges,
                // the arrow beside it picks another way.
                <div className="flex shrink-0 items-center">
                    <Button
                        size="sm"
                        variant="outline"
                        // Two halves of one control: the inner corners stay square.
                        className={cn(mergeMethods.length > 1 && 'rounded-r-none')}
                        disabled={busy === 'merge'}
                        onClick={() => void merge()}
                    >
                        <Icon name={busy === 'merge' ? 'loader-4' : 'git-merge'} className={busy === 'merge' ? 'size-3.5 animate-spin' : 'size-3.5'} />
                        {t(MERGE_METHOD_LABELS[mergeMethod])}
                    </Button>
                    {mergeMethods.length > 1 ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-l-none border-l-0 px-1.5"
                                    disabled={busy === 'merge'}
                                    aria-label={t('sourceBoard.merge.methodAria')}
                                >
                                    <Icon name="arrow-down-s" className="size-3.5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56">
                                <DropdownMenuRadioGroup value={mergeMethod} onValueChange={(value) => chooseMergeMethod(String(value))}>
                                    {mergeMethods.map((method) => (
                                        <DropdownMenuRadioItem key={method} value={method}>{t(MERGE_METHOD_LABELS[method])}</DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            ) : null}
            {openPull?.draft && capabilities?.draftChangeRequests ? (
                <ActionButton icon="git-pull-request" label={t('sourceBoard.actions.markReady')} busy={busy === 'ready'} onClick={() => void markReady()} />
            ) : null}
        </>
    );

    // One row: where the work starts or what the PR needs on the left, the
    // ways to start on the right, the main one last as in a dialog footer.
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <div className="mr-auto flex min-w-0 items-center gap-2">
                {startIn}
                {maintenance}
            </div>
            {project || currentSessionId ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="default" className="shrink-0">
                            <Icon name="attachment-2" className="size-3.5" />
                            {t('sourceBoard.actions.attach')}
                            <Icon name="arrow-down-s" className="size-3.5 opacity-70" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                        {currentSessionId ? (
                            <DropdownMenuItem onSelect={attachToCurrentSession}>
                                <Icon name="chat-4" className="size-4 shrink-0" />
                                <span className="flex min-w-0 flex-col">
                                    <span>{t('sourceBoard.actions.currentSession')}</span>
                                    {currentSession?.title ? (
                                        <span className="truncate typography-micro text-muted-foreground">{currentSession.title}</span>
                                    ) : null}
                                </span>
                            </DropdownMenuItem>
                        ) : null}
                        {project ? (
                            <>
                                <DropdownMenuItem onSelect={startSession}>
                                    <Icon name="chat-new" className="size-4 shrink-0" />
                                    {t('sourceBoard.actions.newSession')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => onStartWorktree(project, selectionOf(item))}>
                                    <Icon name="git-branch" className="size-4 shrink-0" />
                                    {t(pull ? 'sourceBoard.actions.checkoutWorktree' : 'sourceBoard.actions.newWorktreeSession')}
                                </DropdownMenuItem>
                            </>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            {confirmation.dialog}
        </div>
    );
};

const LINK_CLASS = cn(
    'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground',
    REFERENCE_META_TEXT,
);

/**
 * Where to look at a PR's changes: the diff view's PR comparison, or its
 * walkthrough. Both open beside the chat, in the folder the app shows when it
 * belongs to the project; otherwise the app moves to the project first.
 */
export const SourceBoardPullLinks: React.FC<{
    pull: GitHubPullReference;
    project: SourceBoardProject;
    context: SourceControlReadContext;
    projectOwnsDirectory: (directory: string | undefined) => boolean;
    currentDirectory: string | undefined;
}> = ({ pull, project, context, projectOwnsDirectory, currentDirectory }) => {
    const { t } = useI18n();
    const open = (surface: 'diff' | 'walkthrough') => {
        const source: PullRequestSource = { kind: 'pr', number: pull.number, sourceRepo: { owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo } };
        const ui = useUIStore.getState();
        const directory = currentDirectory && projectOwnsDirectory(currentDirectory) ? currentDirectory : project.path;
        if (directory === currentDirectory) ui.closeMainSurfaces();
        else useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        if (surface === 'diff') {
            usePullRequestSelectionStore.getState().requestDiff(directory, source);
            ui.openContextPanelTab(directory, { mode: 'diff', diffScope: 'pr' });
            return;
        }
        useWalkthroughStore.getState().requestTarget(directory, { source, context });
        ui.openContextSurface(directory, 'walkthrough');
    };
    return (
        <span className="inline-flex items-center gap-1">
            <button type="button" className={LINK_CLASS} onClick={() => open('diff')}>
                <DiffViewIcon className="size-3.5" />
                {t('sourceBoard.actions.changes')}
                <Icon name="external-link" className="size-3.5" />
            </button>
            <button type="button" className={LINK_CLASS} onClick={() => open('walkthrough')}>
                <Icon name="route" className="size-3.5 text-[var(--status-info)]" />
                {t('walkthrough.action.open')}
                <Icon name="external-link" className="size-3.5" />
            </button>
        </span>
    );
};


/**
 * Close or reopen for the previewed issue or PR, as items of its state pill's
 * menu. Null for a merged PR or Linear, which have neither here.
 */
export const SourceBoardStateMenuItems: React.FC<{
    item: ReferencePickerItem;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ item, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    // An open issue or PR closes, a closed one reopens; a merged PR stays as it is.
    const repositoryItem = item.source === 'github' ? item.reference : null;
    const nextState = !repositoryItem || repositoryItem.state === 'merged' ? null : repositoryItem.state === 'open' ? 'closed' : 'open';
    const stateLabel = (() => {
        if (!repositoryItem || !nextState) return '';
        if (repositoryItem.kind === 'issue') return t(nextState === 'closed' ? 'sourceBoard.actions.closeIssue' : 'sourceBoard.actions.reopenIssue');
        const gitlab = repositoryItem.provider === 'gitlab';
        if (nextState === 'closed') return t(gitlab ? 'sourceBoard.actions.closePull.gitlab' : 'sourceBoard.actions.closePull.github');
        return t(gitlab ? 'sourceBoard.actions.reopenPull.gitlab' : 'sourceBoard.actions.reopenPull.github');
    })();

    const changeState = async () => {
        if (!repositoryItem || !nextState) return;
        const label = referenceNumberLabel(repositoryItem);
        try {
            const payload: SetStateInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: repositoryItem.sourceRepo.owner, name: repositoryItem.sourceRepo.repo }, number: repositoryItem.number },
                state: nextState,
            };
            if (repositoryItem.kind === 'pull') await sourceControl.changeRequestSetState(payload);
            else await sourceControl.issueSetState(payload);
            toast.success(t(nextState === 'closed' ? 'sourceBoard.toast.closed' : 'sourceBoard.toast.reopened', { reference: label }));
        } catch (error) {
            toast.error(
                t(nextState === 'closed' ? 'sourceBoard.toast.closeFailed' : 'sourceBoard.toast.reopenFailed', { reference: label }),
                { description: error instanceof Error ? error.message : String(error) },
            );
        } finally {
            onChanged();
        }
    };

    if (!repositoryItem || !nextState) return null;
    return (
        <DropdownMenuItem onSelect={() => void changeState()}>
            <Icon name={nextState === 'open' ? 'arrow-go-back' : repositoryItem.kind === 'pull' ? 'git-close-pull-request' : 'checkbox-circle'} className="size-4 shrink-0" />
            {stateLabel}
        </DropdownMenuItem>
    );
};
