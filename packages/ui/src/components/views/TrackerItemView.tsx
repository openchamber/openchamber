import * as React from 'react';

import { ReferencePreview } from '@/components/references/ReferencePreview';
import { DEFAULT_REPOSITORY_FILTER, type ReferencePickerItem } from '@/components/references/referencePickerItems';
import {
    forgetGitHubPullStatuses,
    useGitHubPullStatuses,
    useGitHubReadContext,
    useGitHubReferenceDetail,
    useGitHubReferenceList,
    useLinearIssueDetail,
    useLinearSourceStatus,
} from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardPullLinks, SourceBoardStateMenuItems } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLinearStatus } from '@/components/sourceBoard/SourceBoardLinearStatus';
import { SourceBoardLabels, SourceBoardReviewers } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { isSameRepositoryItemLink, settleTrackerItemRequest, trackerTargetOfUrl, useShowTrackerItem, wasTrackerItemRequested } from '@/components/sourceBoard/openTrackerItem';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

type TrackerItemViewProps = {
    /** The item's link, as its tab keeps it. */
    url: string;
    /** The folder the item is read through: its project's, or the panel's own. */
    directory: string;
    /** The panel the tab lives in, and the tab itself. */
    panelDirectory: string;
    tabId: string;
    /** The tab reads through another project than the panel's. */
    foreign: boolean;
    visible: boolean;
};

/**
 * One issue, pull or merge request or Linear issue in the Tracker, drawn as
 * the issues and PRs board previews it: description, activity, checks,
 * labels, reviewers, a reply box, merge and close. Nothing here starts a
 * session or a worktree; the item can be attached to the session on screen.
 * A link its project cannot read, opened just now, opens in the browser
 * instead and its tab closes; restored on launch, the tab says so in place.
 */
export const TrackerItemView: React.FC<TrackerItemViewProps> = (props) => {
    const target = trackerTargetOfUrl(props.url);
    useBoardRevalidation(props.visible);
    const { panelDirectory, tabId, url } = props;
    const fallBack = React.useCallback(() => {
        if (!wasTrackerItemRequested(panelDirectory, tabId)) return;
        void openExternalUrl(url);
        useUIStore.getState().closeContextPanelTab(panelDirectory, tabId);
    }, [panelDirectory, tabId, url]);
    const settle = React.useCallback(() => settleTrackerItemRequest(panelDirectory, tabId), [panelDirectory, tabId]);

    const content = !target
        ? <UnavailableState url={url} />
        : target.source === 'linear'
            ? <LinearTrackerItem url={url} identifier={target.identifier} onUnavailable={fallBack} onShown={settle} />
            : <RepositoryTrackerItem {...props} kind={target.kind} onUnavailable={fallBack} onShown={settle} />;

    // The preview scrolls on its own, with its actions pinned under it.
    return <div className="h-full min-h-0">{content}</div>;
};

const TrackerState: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => {
    const { t } = useI18n();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center typography-meta text-muted-foreground">
            <span>{message}</span>
            {onRetry ? <Button size="sm" variant="outline" onClick={onRetry}>{t('references.picker.actions.retry')}</Button> : null}
        </div>
    );
};

/** What a restored tab shows when its project cannot read the item. */
const UnavailableState: React.FC<{ url: string }> = ({ url }) => {
    const { t } = useI18n();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center typography-meta text-muted-foreground">
            <span>{t('contextPanel.tracker.unavailable')}</span>
            <Button size="sm" variant="outline" onClick={() => void openExternalUrl(url)}>{t('contextPanel.preview.actions.openExternal')}</Button>
        </div>
    );
};

/** Opens the item in the browser and closes its tab when a click just opened it; else the tab says why. */
type FallBack = () => void;

const RepositoryTrackerItem: React.FC<TrackerItemViewProps & { kind: GitHubReferenceKind; onUnavailable: FallBack; onShown: () => void }> = ({
    url, directory, panelDirectory, foreign, kind, onUnavailable, onShown,
}) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    // The link itself is the search: it finds that one item, whatever its state.
    const lookup = useGitHubReferenceList({ enabled: true, directory, kind, filter: DEFAULT_REPOSITORY_FILTER, query: url });
    // Only the item the link names: a lookup that fell back to a search lists others.
    const reference = lookup.items.find((item) => isSameRepositoryItemLink(item.url, url)) ?? null;
    const readContext = useGitHubReadContext(directory);
    const context = readContext && readContext !== 'missing' ? readContext : null;

    // Answered without it: the project's host does not know the link, or no
    // account can read it. A failed read stays here with a retry instead.
    const unavailable = (lookup.status === 'ready' || lookup.status === 'unavailable') && !lookup.refreshing && !reference;
    React.useEffect(() => {
        if (unavailable) onUnavailable();
    }, [onUnavailable, unavailable]);
    const found = reference !== null;
    React.useEffect(() => {
        if (found) onShown();
    }, [found, onShown]);

    const { detail, refresh: refreshDetail } = useGitHubReferenceDetail(directory, reference, true);
    const pullStatusOf = useGitHubPullStatuses(directory, reference ? [reference] : []);
    const attachments = usePullAttachments(reference);
    const [checksOpen, setChecksOpen] = React.useState(false);
    // The tab can stay open for hours; a frozen clock read every newer comment as "Just now".
    const now = useMinuteTickerNow(true);

    const { retry: retryLookup } = lookup;
    // After a change to the item: its detail and the item itself read again.
    const refreshItem = React.useCallback(
        () => Promise.all([refreshDetail(), retryLookup()]).then(() => undefined),
        [refreshDetail, retryLookup],
    );
    const threadActions = useThreadActions(reference, context, refreshItem);
    // For a change made on the host's own site, which the server's
    // short-lived answers would otherwise hide for up to half a minute.
    const refreshFromHost = async () => {
        if (context) await sourceControl.refreshProviderReads(context).catch(() => undefined);
        forgetGitHubPullStatuses();
        await refreshItem();
    };

    if (!reference) {
        if (unavailable) return <UnavailableState url={url} />;
        return lookup.status === 'error'
            ? <TrackerState message={lookup.error ?? t('contextPanel.tracker.loadFailed')} onRetry={() => void retryLookup()} />
            : <TrackerState message={t('common.loading')} />;
    }

    const item: ReferencePickerItem = { source: 'github', reference };
    const pull = reference.kind === 'pull' ? reference : null;
    return (
        <>
            <ReferencePreview
                item={item}
                directory={directory}
                pullStatus={pull ? pullStatusOf(pull) : IDLE_PULL_STATUS}
                linearDetail={{ status: 'idle' }}
                githubDetail={detail}
                purpose="attach"
                pinned
                includeDiff={false}
                onIncludeDiffChange={() => undefined}
                now={now}
                // Starting work happens on the board and in New Worktree; here the item is read and acted on.
                footer={<SourceBoardActions item={item} project={null} context={context} onStartWorktree={() => undefined} onChanged={() => void refreshItem()} />}
                onOpenChecks={pull && context ? () => setChecksOpen(true) : undefined}
                onRefresh={context ? refreshFromHost : undefined}
                threadActions={threadActions}
                stateMenu={reference.state !== 'merged' && context ? (
                    <SourceBoardStateMenuItems item={item} context={context} onChanged={() => void refreshItem()} />
                ) : undefined}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                labelsControl={context ? <SourceBoardLabels reference={reference} context={context} onChanged={refreshItem} /> : undefined}
                reviewersControl={pull && context ? (
                    <SourceBoardReviewers pull={pull} detail={detail} context={context} onChanged={refreshItem} />
                ) : undefined}
                reply={context ? <SourceBoardReply reference={reference} context={context} onRefresh={refreshItem} /> : undefined}
                pullLinks={pull && context ? (
                    <SourceBoardPullLinks
                        pull={pull}
                        project={{ id: activeProjectId ?? '', path: directory }}
                        context={context}
                        projectOwnsDirectory={() => !foreign}
                        currentDirectory={panelDirectory}
                    />
                ) : null}
            />
            {pull && context ? (
                <SourceBoardChecksDialog
                    pull={pull}
                    context={context}
                    open={checksOpen}
                    onOpenChange={setChecksOpen}
                    onAttachFailed={attachments.attachFailedChecks}
                />
            ) : null}
        </>
    );
};

const LinearTrackerItem: React.FC<{ url: string; identifier: string; onUnavailable: FallBack; onShown: () => void }> = ({ url, identifier, onUnavailable, onShown }) => {
    const { t } = useI18n();
    const source = useLinearSourceStatus();
    const { detail, refresh } = useLinearIssueDetail(source === 'ready' ? identifier : null, true);
    const showTrackerItem = useShowTrackerItem();
    const now = useMinuteTickerNow(true);

    // Linear answers the same for an issue it cannot find and a read that
    // failed, so only a tab just opened that never showed its issue gives up
    // on a failure; any other one offers Retry.
    const disconnected = source !== 'ready';
    const failed = detail.status === 'error';
    const ready = detail.status === 'ready';
    React.useEffect(() => {
        if (disconnected || failed) onUnavailable();
    }, [disconnected, failed, onUnavailable]);
    React.useEffect(() => {
        if (ready) onShown();
    }, [onShown, ready]);

    if (disconnected) return <UnavailableState url={url} />;
    if (detail.status === 'error') {
        return <TrackerState message={detail.error || t('contextPanel.tracker.loadFailed')} onRetry={() => void refresh()} />;
    }
    if (detail.status !== 'ready') return <TrackerState message={t('common.loading')} />;

    const item: ReferencePickerItem = { source: 'linear', issue: detail.value };
    return (
        <ReferencePreview
            item={item}
            directory={null}
            pullStatus={IDLE_PULL_STATUS}
            linearDetail={detail}
            githubDetail={{ status: 'idle' }}
            purpose="attach"
            pinned
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={now}
            footer={<SourceBoardActions item={item} project={null} context={null} onStartWorktree={() => undefined} onChanged={() => void refresh()} />}
            linearStateControl={<SourceBoardLinearStatus issue={detail.value} onChanged={() => void refresh()} />}
            // A parent or sub-issue opens as a tab of its own.
            onOpenLinearIssue={(issue) => { showTrackerItem(issue.url, null); }}
        />
    );
};
