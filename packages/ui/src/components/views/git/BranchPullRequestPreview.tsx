import * as React from 'react';

import { pullReferenceFromChangeRequest } from '@/components/references/listBackedReferences';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { forgetRepositoryPullStatus, useRepositoryReferenceDetail } from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { CachedValue } from '@/components/references/referenceCache';
import type { PullRequestStack, RepositoryChangeRequestReference, RepositoryReferenceDetail, SourceControlReadContext } from '@/lib/api/types';
import type { ChangeRequest } from '@/lib/source-control/types';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { useShowTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Labels and the comment count the branch status does not carry: a provider
 * with a reference search (`features.referenceSearch`, GitHub) answers `#N`
 * with the PR as its lists show it. A list-backed provider's status carries
 * its labels already (GitLab), so it keeps what its status says.
 */
function useListedPull(context: SourceControlReadContext, number: number, revision: number): RepositoryChangeRequestReference | null {
    const { sourceControl } = useRuntimeAPIs();
    const searchable = useSourceControlProvider(context.provider).features.referenceSearch;
    const [listed, setListed] = React.useState<{ key: string; pull: RepositoryChangeRequestReference } | null>(null);
    const key = JSON.stringify([context.provider, context.repositoryId, context.bindingRevision, number]);
    React.useEffect(() => {
        if (!searchable) return;
        let cancelled = false;
        void sourceControl.references(context, { kind: 'pull', query: `#${number}` })
            .then((result) => {
                if (cancelled || !result.connected) return;
                const pull = result.items.find((item): item is RepositoryChangeRequestReference => item.kind === 'pull' && item.number === number);
                if (pull) setListed({ key, pull });
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [context, key, number, revision, searchable, sourceControl]);
    return listed?.key === key ? listed.pull : null;
}

/**
 * The checked-out branch's pull request, drawn as the issues and PRs board
 * previews one: description, activity with its commits, checks, reviewers,
 * labels, a reply box and the merge and close actions. Comments and failed
 * checks can be pinned above the composer.
 */
export const BranchPullRequestPreview: React.FC<{
    /** The repository the branch is in. */
    directory: string;
    context: SourceControlReadContext;
    changeRequest: ChangeRequest;
    /** Asks the branch status again after a change. */
    onChanged: () => Promise<void>;
    /**
     * The chain the branch status names, where changes are created by pushing
     * for review; shown until the change's own detail says.
     */
    statusStack?: PullRequestStack | null;
}> = ({ directory, context, changeRequest, onChanged, statusStack }) => {
    const { sourceControl } = useRuntimeAPIs();
    const rootDirectory = useEffectiveDirectory();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const [revision, setRevision] = React.useState(0);
    const [checksOpen, setChecksOpen] = React.useState(false);
    // The Git panel stays mounted for hours; a frozen clock read every newer comment as "Just now".
    const now = useMinuteTickerNow(true);

    const listed = useListedPull(context, changeRequest.number, revision);
    const reference = React.useMemo<RepositoryChangeRequestReference>(() => {
        const live = pullReferenceFromChangeRequest(changeRequest);
        // The status is the fresher source of state and head; the list adds what it lacks.
        return listed ? { ...live, labels: listed.labels, commentCount: listed.commentCount } : live;
    }, [changeRequest, listed]);
    // The revision picked to look at; null shows the latest. Another change starts on its latest again.
    const [revisionChoice, setRevisionChoice] = React.useState<{ number: number; sha: string } | null>(null);
    const shownRevision = revisionChoice?.number === changeRequest.number ? revisionChoice.sha : null;
    const { detail, latest, refresh: refreshDetail } = useRepositoryReferenceDetail(directory, reference, true, shownRevision);
    const latestPull = latest.status === 'ready' ? latest.value.pull : null;
    const attachments = usePullAttachments(reference);

    const refresh = React.useCallback(() => {
        refreshDetail();
        setRevision((value) => value + 1);
        void onChanged();
    }, [onChanged, refreshDetail]);
    const threadActions = useThreadActions(reference, context, refresh);
    // The header's refresh button, for a change made on the host's own site:
    // the server forgets its short-lived answers about this PR first.
    const refreshFromHost = async () => {
        const pull = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number };
        await sourceControl.refreshProviderReads(context, { item: pull }).catch(() => undefined);
        forgetRepositoryPullStatus(pull);
        setRevision((value) => value + 1);
        await Promise.all([refreshDetail(), onChanged()]);
    };

    const item = { source: 'repository' as const, reference };
    const linksDirectory = rootDirectory ?? directory;
    // The change's own detail says which chain it is in; until it does, or where it cannot, the status's chain stands in.
    const shownDetail = React.useMemo<CachedValue<RepositoryReferenceDetail>>(() => (
        detail.status === 'ready' && detail.value.pull && detail.value.pull.stack === undefined && statusStack !== undefined
            ? { status: 'ready', value: { ...detail.value, pull: { ...detail.value.pull, stack: statusStack } } }
            : detail
    ), [detail, statusStack]);
    const stack = shownDetail.status === 'ready' ? shownDetail.value.pull?.stack ?? null : statusStack ?? null;
    // Another layer of the stack opens in the Tracker; a new one starts in a worktree on top of this branch.
    const showTrackerItem = useShowTrackerItem();
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const ownProject = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
    const [onTopOpen, setOnTopOpen] = React.useState(false);

    return (
        <>
            <ReferencePreview
                item={item}
                directory={directory}
                pullStatus={IDLE_PULL_STATUS}
                trackerDetail={{ status: 'idle' }}
                repositoryDetail={shownDetail}
                purpose="attach"
                pinned
                includeDiff={false}
                onIncludeDiffChange={() => undefined}
                now={now}
                // This branch is already checked out here: no new session or worktree from it.
                footer={(
                    <SourceBoardActions
                        item={item}
                        project={null}
                        context={context}
                        onStartWorktree={() => undefined}
                        onChanged={refresh}
                        worktreeAvailable={false}
                        stack={stack}
                        onStartOnTop={ownProject ? () => setOnTopOpen(true) : undefined}
                        submitRequirements={latestPull?.submitRequirements}
                        submitRequirementsUnreadable={latest.status === 'error'}
                        mergeable={changeRequest.mergeable ?? null}
                    />
                )}
                revisionChoice={latestPull?.revisions ? {
                    revisions: latestPull.revisions,
                    selected: shownRevision,
                    onSelect: (sha) => setRevisionChoice(sha ? { number: changeRequest.number, sha } : null),
                } : undefined}
                onOpenStackLayer={(layer) => { showTrackerItem(layer.url, directory); }}
                onOpenChecks={() => setChecksOpen(true)}
                onRefresh={refreshFromHost}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                threadActions={threadActions}
                labelsControl={<SourceBoardLabels reference={reference} context={context} onChanged={refresh} />}
                reviewersControl={<SourceBoardReviewers pull={reference} detail={detail} context={context} onChanged={refresh} />}
                reply={(
                    <SourceBoardReply
                        key={reference.number}
                        reference={reference}
                        context={context}
                        onRefresh={refresh}
                        voteLabels={latestPull?.voteLabels}
                        latestRevision={latestPull?.revisions?.at(-1)?.sha}
                        onLatestRevision={shownRevision === null}
                    />
                )}
                pullLinks={(
                    <SourceBoardPullLinks
                        pull={reference}
                        project={{ id: activeProjectId ?? '', path: linksDirectory }}
                        repository={null}
                        context={context}
                        projectOwnsDirectory={() => true}
                        currentDirectory={linksDirectory}
                        revision={shownRevision}
                    />
                )}
            />
            <SourceBoardChecksDialog
                pull={reference}
                context={context}
                open={checksOpen}
                onOpenChange={setChecksOpen}
                onAttachFailed={attachments.attachFailedChecks}
            />
            {ownProject ? (
                <NewWorktreeDialog
                    open={onTopOpen}
                    onOpenChange={setOnTopOpen}
                    project={{ id: ownProject.id, path: normalizeProjectPath(ownProject.path) ?? ownProject.path }}
                    initialSourceBranch={reference.head}
                    onWorktreeCreated={(worktreePath) => {
                        useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: worktreePath, preserveDirectoryOverride: true });
                    }}
                />
            ) : null}
        </>
    );
};
