import * as React from 'react';

import { pullReferenceFromChangeRequest } from '@/components/references/gitlabReferences';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { useGitHubReferenceDetail } from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import type { ChangeRequest } from '@/lib/source-control/types';
import { useProjectsStore } from '@/stores/useProjectsStore';

/**
 * Labels and the comment count the branch status does not carry: GitHub
 * answers `#N` with the PR as its lists show it. GitLab's lists carry neither,
 * so a GitLab merge request keeps what its status says.
 */
function useListedPull(context: SourceControlReadContext, number: number, revision: number): GitHubPullReference | null {
    const { sourceControl } = useRuntimeAPIs();
    const [listed, setListed] = React.useState<{ key: string; pull: GitHubPullReference } | null>(null);
    const key = JSON.stringify([context.provider, context.repositoryId, context.bindingRevision, number]);
    React.useEffect(() => {
        if (context.provider !== 'github') return;
        let cancelled = false;
        void sourceControl.githubReferences(context, { kind: 'pull', query: `#${number}` })
            .then((result) => {
                if (cancelled || !result.connected) return;
                const pull = result.items.find((item): item is GitHubPullReference => item.kind === 'pull' && item.number === number);
                if (pull) setListed({ key, pull });
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [context, key, number, revision, sourceControl]);
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
    onChanged: () => void;
}> = ({ directory, context, changeRequest, onChanged }) => {
    const rootDirectory = useEffectiveDirectory();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const [revision, setRevision] = React.useState(0);
    const [checksOpen, setChecksOpen] = React.useState(false);
    const [now] = React.useState(() => Date.now());

    const listed = useListedPull(context, changeRequest.number, revision);
    const reference = React.useMemo<GitHubPullReference>(() => {
        const live = pullReferenceFromChangeRequest(changeRequest);
        // The status is the fresher source of state and head; the list adds what it lacks.
        return listed ? { ...live, labels: listed.labels, commentCount: listed.commentCount } : live;
    }, [changeRequest, listed]);
    const { detail, refresh: refreshDetail } = useGitHubReferenceDetail(directory, reference, true);
    const attachments = usePullAttachments(reference);

    const refresh = React.useCallback(() => {
        refreshDetail();
        setRevision((value) => value + 1);
        onChanged();
    }, [onChanged, refreshDetail]);

    const item = { source: 'github' as const, reference };
    const linksDirectory = rootDirectory ?? directory;

    return (
        <>
            <ReferencePreview
                item={item}
                pullStatus={IDLE_PULL_STATUS}
                linearDetail={{ status: 'idle' }}
                githubDetail={detail}
                purpose="attach"
                pinned
                includeDiff={false}
                onIncludeDiffChange={() => undefined}
                now={now}
                // This branch is already checked out here: no new session or worktree from it.
                footer={<SourceBoardActions item={item} project={null} context={context} onStartWorktree={() => undefined} onChanged={refresh} />}
                onOpenChecks={() => setChecksOpen(true)}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                labelsControl={<SourceBoardLabels reference={reference} context={context} onChanged={refresh} />}
                reviewersControl={<SourceBoardReviewers pull={reference} detail={detail} context={context} onChanged={refresh} />}
                reply={<SourceBoardReply key={reference.number} reference={reference} context={context} onRefresh={refresh} />}
                pullLinks={(
                    <SourceBoardPullLinks
                        pull={reference}
                        project={{ id: activeProjectId ?? '', path: linksDirectory }}
                        context={context}
                        projectOwnsDirectory={() => true}
                        currentDirectory={linksDirectory}
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
        </>
    );
};
