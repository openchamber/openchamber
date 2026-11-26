import * as React from 'react';

import { pullReferenceFromChangeRequest } from '@/components/references/listBackedReferences';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { canChangeReferenceState } from '@/components/references/referencePickerItems';
import type { ReferenceCommentActions } from '@/components/references/ReferenceComments';
import { forgetRepositoryPullStatus, useRepositoryReferenceDetail } from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardPullLinks, SourceBoardStateMenuItems } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewerPicker } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { updateRepositoryItemText } from '@/components/sourceBoard/updateItemText';
import { deleteRepositoryComment, updateRepositoryComment } from '@/components/sourceBoard/updateItemComment';
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

export const BranchPullRequestPreview: React.FC<{
    directory: string;
    context: SourceControlReadContext;
    changeRequest: ChangeRequest;
    onChanged: () => Promise<void>;
    statusStack?: PullRequestStack | null;
}> = ({ directory, context, changeRequest, onChanged, statusStack }) => {
    const { sourceControl } = useRuntimeAPIs();
    const rootDirectory = useEffectiveDirectory();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const [revision, setRevision] = React.useState(0);
    const [checksOpen, setChecksOpen] = React.useState(false);
    const now = useMinuteTickerNow(true);

    const listed = useListedPull(context, changeRequest.number, revision);
    const reference = React.useMemo<RepositoryChangeRequestReference>(() => {
        const live = pullReferenceFromChangeRequest(changeRequest);
        return listed ? { ...live, labels: listed.labels, commentCount: listed.commentCount } : live;
    }, [changeRequest, listed]);
    const [revisionChoice, setRevisionChoice] = React.useState<{ number: number; sha: string } | null>(null);
    const shownRevision = revisionChoice?.number === changeRequest.number ? revisionChoice.sha : null;
    const { detail, latest, refresh: refreshDetail } = useRepositoryReferenceDetail(directory, reference, true, shownRevision);
    const latestPull = latest.status === 'ready' ? latest.value.pull : null;
    const attachments = usePullAttachments(reference);

    const refresh = React.useCallback(() => {
        setRevision((value) => value + 1);
        return Promise.all([refreshDetail(), onChanged()]).then(() => undefined);
    }, [onChanged, refreshDetail]);
    const saveText = async (input: { title: string; body: string }) => {
        await updateRepositoryItemText(sourceControl, context, reference, input);
        refresh();
    };
    const threadActions = useThreadActions(reference, context, refresh);
    const commentActions: ReferenceCommentActions = {
        update: async (comment, body) => {
            if (!comment.id) return;
            await updateRepositoryComment(sourceControl, context, reference, { id: comment.id }, body);
            refresh();
        },
        remove: async (comment) => {
            if (!comment.id) return;
            await deleteRepositoryComment(sourceControl, context, reference, { id: comment.id });
            refresh();
        },
    };
    const refreshFromHost = async () => {
        const pull = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number };
        await sourceControl.refreshProviderReads(context, { item: pull }).catch(() => undefined);
        forgetRepositoryPullStatus(pull);
        setRevision((value) => value + 1);
        await Promise.all([refreshDetail(), onChanged()]);
    };

    const item = { source: 'repository' as const, reference };
    const linksDirectory = rootDirectory ?? directory;
    const shownDetail = React.useMemo<CachedValue<RepositoryReferenceDetail>>(() => (
        detail.status === 'ready' && detail.value.pull && detail.value.pull.stack === undefined && statusStack !== undefined
            ? { status: 'ready', value: { ...detail.value, pull: { ...detail.value.pull, stack: statusStack } } }
            : detail
    ), [detail, statusStack]);
    const stack = shownDetail.status === 'ready' ? shownDetail.value.pull?.stack ?? null : statusStack ?? null;
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
                        branchWriteAccess={detail.status === 'ready' ? detail.value.branchWriteAccess : undefined}
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
                onSaveText={saveText}
                stateMenu={canChangeReferenceState(reference, detail.status === 'ready' ? detail.value : null) ? (
                    <SourceBoardStateMenuItems item={item} context={context} onChanged={refresh} />
                ) : undefined}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                threadActions={threadActions}
                commentActions={commentActions}
                labelsControl={<SourceBoardLabels reference={reference} context={context} onChanged={refresh} />}
                reviewersControl={<SourceBoardReviewerPicker pull={reference} detail={detail} context={context} onChanged={refresh} />}
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
                        writeAccess={detail.status === 'ready' ? detail.value.writeAccess : undefined}
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
