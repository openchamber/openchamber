import * as React from 'react';

import { ReferencePreview } from '@/components/references/ReferencePreview';
import { canChangeDiscussionState, DEFAULT_REPOSITORY_FILTER, type ReferencePickerItem } from '@/components/references/referencePickerItems';
import {
    forgetRepositoryPullStatus,
    useRepositoryPullStatuses,
    useRepositoryReadContext,
    useRepositoryReferenceDetail,
    useRepositoryReferenceList,
    useTrackerItemDetail,
} from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardPullLinks, SourceBoardStateMenuItems } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { SourceBoardTrackerStatus } from '@/components/sourceBoard/SourceBoardTrackerStatus';
import { isSameRepositoryItemLink, settleTrackerItemRequest, trackerTargetOfUrl, useShowTrackerItem, wasTrackerItemRequested } from '@/components/sourceBoard/openTrackerItem';
import { useLinkRepository } from '@/components/sourceBoard/boardRepository';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference, RepositoryReferenceKind } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { repositoryItemLink, repositoryLinkContextOfUrl } from '@/lib/source-control/repositoryLinks';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { isTrackedWorkItem, type TrackedItem } from '@/lib/trackedItems/model';
import { useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { useTrackerSourceStatus } from '@/lib/trackers/sources';
import { openExternalUrl } from '@/lib/url';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

const NO_FOLLOWED: TrackedItem[] = [];

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
 * One issue, discussion, pull or merge request or tracker item in the Tracker, drawn as
 * the issues and PRs board previews it: description, activity, checks,
 * labels, reviewers, a reply box, merge and close. Nothing here starts a
 * session or a worktree; the item can be attached to the session on screen.
 * A link its project cannot read, opened just now, opens in the browser
 * instead and its tab closes; restored on launch, the tab says so in place.
 * A project that is a folder of repositories reads the link through the
 * repository whose remote it points into.
 */
export const TrackerItemView: React.FC<TrackerItemViewProps> = (props) => {
    const urls = useRepositoryUrlMatcher();
    const trackerUrls = useTrackerUrlMatcher();
    const target = trackerTargetOfUrl(props.url, urls, trackerUrls);
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
        : target.source === 'tracker'
            ? <TrackerWorkItem url={url} provider={target.provider} identifier={target.identifier} visible={props.visible} onUnavailable={fallBack} onShown={settle} />
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

const RepositoryTrackerItem: React.FC<TrackerItemViewProps & { kind: RepositoryReferenceKind; onUnavailable: FallBack; onShown: () => void }> = ({
    url, directory, panelDirectory, foreign, visible, kind, onUnavailable, onShown,
}) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    // A folder of repositories reads the link through the one it points into.
    const linkRepository = useLinkRepository(directory, url);
    const readDirectory = linkRepository.directory;
    // The link itself is the search: it finds that one item, whatever its state.
    const issueLookup = useRepositoryReferenceList({ enabled: linkRepository.status === 'ready', directory: readDirectory, kind, filter: DEFAULT_REPOSITORY_FILTER, query: url });
    // Only the item the link names: a lookup that fell back to a search lists others.
    const urls = useRepositoryUrlMatcher();
    const named = (items: readonly RepositoryReference[]) => items.find((item) => isSameRepositoryItemLink(item.url, url, urls)) ?? null;
    // Where issues and change requests share one number, an issue link may
    // name a change request (`#12` in an item's text links its issue page,
    // which the host forwards). A host whose issue lookup does not answer it
    // (a list-backed one) reads the number as a change request, by that
    // request's own link. Once the issue is known missing, it stays so for
    // this link, so a background refresh does not swap the shown item out.
    const pullUrl = React.useMemo(() => {
        const context = kind === 'issue' ? repositoryLinkContextOfUrl(url, urls) : null;
        const item = urls.match(url);
        return context?.descriptor.terminology.sharedNumberSpace && item ? repositoryItemLink(context, 'pull', item.number) : null;
    }, [kind, url, urls]);
    const issueSettled = (issueLookup.status === 'ready' || issueLookup.status === 'unavailable') && !issueLookup.refreshing;
    const [issueMissingFor, setIssueMissingFor] = React.useState<string | null>(null);
    const issueMissing = issueMissingFor === url;
    if (pullUrl && !issueMissing && issueSettled && !named(issueLookup.items)) setIssueMissingFor(url);
    const pullLookup = useRepositoryReferenceList({ enabled: issueMissing && pullUrl !== null && linkRepository.status === 'ready', directory: readDirectory, kind: 'pull', filter: DEFAULT_REPOSITORY_FILTER, query: pullUrl ?? '' });
    const lookup = issueMissing ? pullLookup : issueLookup;
    const reference = named(lookup.items);
    // While the tab is on screen its item's state, checks included, follows the
    // host; the other rows of a lookup that fell back to a search do not.
    const followed = React.useMemo(
        () => lookup.followed.filter((item) => !isTrackedWorkItem(item) && item.number === reference?.number),
        [lookup.followed, reference],
    );
    useTrackedItems(visible ? followed : NO_FOLLOWED);
    const readContext = useRepositoryReadContext(readDirectory);
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

    const { detail, refresh: refreshDetail } = useRepositoryReferenceDetail(readDirectory, reference, true);
    const pullStatusOf = useRepositoryPullStatuses(readDirectory, reference ? [reference] : []);
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
    // Another layer of the PR's stack opens as a tab of its own, read through the same folder.
    const showTrackerItem = useShowTrackerItem();
    const stack = detail.status === 'ready' ? detail.value.pull?.stack ?? null : null;
    // For a change made on the host's own site, which the server's
    // short-lived answers would otherwise hide for up to half a minute: this
    // tab's item alone, its state and checks included.
    const refreshFromHost = async () => {
        if (context && reference) {
            const item = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number };
            await sourceControl.refreshProviderReads(context, { item }).catch(() => undefined);
            forgetRepositoryPullStatus(item);
        }
        await refreshItem();
    };

    if (!reference) {
        if (unavailable) return <UnavailableState url={url} />;
        if (linkRepository.status === 'failed') {
            return <TrackerState message={t('gitView.empty.discoverFailed')} onRetry={linkRepository.retry} />;
        }
        return lookup.status === 'error'
            ? <TrackerState message={lookup.error ?? t('contextPanel.tracker.loadFailed')} onRetry={() => void retryLookup()} />
            : <TrackerState message={t('common.loading')} />;
    }

    const item: ReferencePickerItem = { source: 'repository', reference };
    const pull = reference.kind === 'pull' ? reference : null;
    return (
        <>
            <ReferencePreview
                item={item}
                directory={readDirectory}
                pullStatus={pull ? pullStatusOf(pull) : IDLE_PULL_STATUS}
                trackerDetail={{ status: 'idle' }}
                repositoryDetail={detail}
                purpose="attach"
                pinned
                includeDiff={false}
                onIncludeDiffChange={() => undefined}
                now={now}
                // Starting work happens on the board and in New Worktree; here the item is read and acted on.
                footer={<SourceBoardActions item={item} project={null} context={context} onStartWorktree={() => undefined} onChanged={() => void refreshItem()} worktreeAvailable={false} stack={stack} />}
                onOpenStackLayer={(layer) => { showTrackerItem(layer.url, directory); }}
                onOpenChecks={pull && context ? () => setChecksOpen(true) : undefined}
                onRefresh={context ? refreshFromHost : undefined}
                threadActions={threadActions}
                stateMenu={reference.state !== 'merged' && context
                    && (reference.kind !== 'discussion' || canChangeDiscussionState(reference, detail.status === 'ready' ? detail.value.discussion : undefined)) ? (
                    <SourceBoardStateMenuItems item={item} context={context} onChanged={() => void refreshItem()} />
                ) : undefined}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                labelsControl={context ? <SourceBoardLabels reference={reference} context={context} onChanged={refreshItem} /> : undefined}
                reviewersControl={pull && context ? (
                    <SourceBoardReviewers pull={pull} detail={detail} context={context} onChanged={refreshItem} />
                ) : undefined}
                // A locked discussion takes no comment from someone who may not update it.
                reply={context && (detail.status !== 'ready' || detail.value.discussion?.canComment !== false)
                    ? <SourceBoardReply reference={reference} context={context} onRefresh={refreshItem} />
                    : undefined}
                pullLinks={pull && context ? (
                    <SourceBoardPullLinks
                        pull={pull}
                        project={{ id: activeProjectId ?? '', path: directory }}
                        repository={readDirectory}
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

const TrackerWorkItem: React.FC<{
    url: string;
    provider: string;
    identifier: string;
    visible: boolean;
    onUnavailable: FallBack;
    onShown: () => void;
}> = ({ url, provider, identifier, visible, onUnavailable, onShown }) => {
    const { t } = useI18n();
    const source = useTrackerSourceStatus(provider);
    // A tracker's get takes its human identifier as well as its own id.
    const { detail, refresh, followed } = useTrackerItemDetail(source === 'ready' ? { provider, id: identifier } : null, true);
    useTrackedItems(visible ? followed : NO_FOLLOWED);
    const showTrackerItem = useShowTrackerItem();
    const now = useMinuteTickerNow(true);

    // A tracker answers the same for an item it cannot find and a read that
    // failed, so only a tab just opened that never showed its item gives up
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

    const item: ReferencePickerItem = { source: 'tracker', provider, item: detail.value };
    return (
        <ReferencePreview
            item={item}
            directory={null}
            pullStatus={IDLE_PULL_STATUS}
            trackerDetail={detail}
            repositoryDetail={{ status: 'idle' }}
            purpose="attach"
            pinned
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={now}
            footer={<SourceBoardActions item={item} project={null} context={null} onStartWorktree={() => undefined} onChanged={() => void refresh()} worktreeAvailable={false} />}
            trackerStateControl={<SourceBoardTrackerStatus item={detail.value} onChanged={() => void refresh()} />}
            // A parent or child opens as a tab of its own.
            onOpenTrackerItem={(child) => { showTrackerItem(child.url, null); }}
        />
    );
};
