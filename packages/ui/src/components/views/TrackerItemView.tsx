import * as React from 'react';

import { ReferencePreview } from '@/components/references/ReferencePreview';
import type { ReferenceCommentActions } from '@/components/references/ReferenceComments';
import { canChangeReferenceState, DEFAULT_REPOSITORY_FILTER, type ReferencePickerItem } from '@/components/references/referencePickerItems';
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
import { SourceBoardAssignees, SourceBoardLabels, SourceBoardReviewerPicker } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { SourceBoardTrackerStatus } from '@/components/sourceBoard/SourceBoardTrackerStatus';
import { isSameRepositoryItemLink, settleTrackerItemRequest, trackerTargetOfUrl, useShowTrackerItem, wasTrackerItemRequested } from '@/components/sourceBoard/openTrackerItem';
import { useLinkRepository } from '@/components/sourceBoard/boardRepository';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { updateRepositoryItemText } from '@/components/sourceBoard/updateItemText';
import { deleteRepositoryComment, updateRepositoryComment } from '@/components/sourceBoard/updateItemComment';
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
    url: string;
    directory: string;
    panelDirectory: string;
    tabId: string;
    foreign: boolean;
    visible: boolean;
};

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

const UnavailableState: React.FC<{ url: string }> = ({ url }) => {
    const { t } = useI18n();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center typography-meta text-muted-foreground">
            <span>{t('contextPanel.tracker.unavailable')}</span>
            <Button size="sm" variant="outline" onClick={() => void openExternalUrl(url)}>{t('contextPanel.preview.actions.openExternal')}</Button>
        </div>
    );
};

type FallBack = () => void;

const useLinkItem = ({ enabled, directory, url, kind, linked }: {
    enabled: boolean;
    directory: string;
    url: string;
    kind: RepositoryReferenceKind;
    linked: boolean;
}) => {
    const issueLookup = useRepositoryReferenceList({ enabled, directory, kind, filter: DEFAULT_REPOSITORY_FILTER, query: url, linked });
    const urls = useRepositoryUrlMatcher();
    const named = (items: readonly RepositoryReference[]) => items.find((item) => isSameRepositoryItemLink(item.url, url, urls)) ?? null;
    const pullUrl = React.useMemo(() => {
        const context = kind === 'issue' ? repositoryLinkContextOfUrl(url, urls) : null;
        const item = urls.match(url);
        return context?.descriptor.terminology.sharedNumberSpace && item ? repositoryItemLink(context, 'pull', item.number) : null;
    }, [kind, url, urls]);
    const answered = (lookup: { status: string; refreshing?: boolean }) => (lookup.status === 'ready' || lookup.status === 'unavailable') && !lookup.refreshing;
    const [issueMissingFor, setIssueMissingFor] = React.useState<string | null>(null);
    const issueMissing = issueMissingFor === url;
    if (enabled && pullUrl && !issueMissing && answered(issueLookup) && !named(issueLookup.items)) setIssueMissingFor(url);
    const pullLookup = useRepositoryReferenceList({ enabled: enabled && issueMissing && pullUrl !== null, directory, kind: 'pull', filter: DEFAULT_REPOSITORY_FILTER, query: pullUrl ?? '', linked });
    const lookup = issueMissing ? pullLookup : issueLookup;
    const reference = named(lookup.items);
    return { lookup, reference, missing: enabled && answered(lookup) && !reference };
};

const RepositoryTrackerItem: React.FC<TrackerItemViewProps & { kind: RepositoryReferenceKind; onUnavailable: FallBack; onShown: () => void }> = ({
    url, directory, panelDirectory, foreign, visible, kind, onUnavailable, onShown,
}) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const linkRepository = useLinkRepository(directory, url);
    const readDirectory = linkRepository.directory;
    const urls = useRepositoryUrlMatcher();
    const readContext = useRepositoryReadContext(readDirectory);
    const boundContext = readContext && readContext !== 'missing' ? readContext : null;
    const bound = useLinkItem({ enabled: linkRepository.status === 'ready', directory: readDirectory, url, kind, linked: false });

    const linkHost = urls.match(url);
    const sameHost = boundContext !== null && linkHost?.provider === boundContext.provider && linkHost.instance === boundContext.instance;
    const boundGaveUp = linkRepository.status === 'ready' && !bound.reference
        && (bound.missing || (bound.lookup.status === 'error' && !linkRepository.owned));
    const outside = useLinkItem({ enabled: boundGaveUp && sameHost, directory: readDirectory, url, kind, linked: true });
    const reference = bound.reference ?? outside.reference;
    const lookup = bound.reference || !boundGaveUp ? bound.lookup : outside.lookup;
    const linked = reference?.linked === true;
    const context = React.useMemo(() => (boundContext && linked ? { ...boundContext, linked: true as const } : boundContext), [boundContext, linked]);
    const writeContext = linked ? null : context;
    const followed = React.useMemo(
        () => lookup.followed.filter((item) => !isTrackedWorkItem(item) && item.number === reference?.number),
        [lookup.followed, reference],
    );
    useTrackedItems(visible ? followed : NO_FOLLOWED);

    const unavailable = boundGaveUp && !reference && (!sameHost || outside.missing || outside.lookup.status === 'error');
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
    const now = useMinuteTickerNow(true);

    const { retry: retryLookup } = lookup;
    const refreshItem = React.useCallback(
        () => Promise.all([refreshDetail(), retryLookup()]).then(() => undefined),
        [refreshDetail, retryLookup],
    );
    const threadActions = useThreadActions(reference, writeContext, refreshItem);
    const showTrackerItem = useShowTrackerItem();
    const stack = detail.status === 'ready' ? detail.value.pull?.stack ?? null : null;
    const refreshFromHost = async () => {
        if (writeContext && reference) {
            const item = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number };
            await sourceControl.refreshProviderReads(writeContext, { item }).catch(() => undefined);
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
    const saveText = writeContext ? async (input: { title: string; body: string }) => {
        await updateRepositoryItemText(sourceControl, writeContext, reference, input);
        await refreshItem();
    } : undefined;
    const commentActions: ReferenceCommentActions | undefined = writeContext ? {
        update: async (comment, body) => {
            if (!comment.id) return;
            await updateRepositoryComment(sourceControl, writeContext, reference, { id: comment.id }, body);
            await refreshItem();
        },
        remove: async (comment) => {
            if (!comment.id) return;
            await deleteRepositoryComment(sourceControl, writeContext, reference, { id: comment.id });
            await refreshItem();
        },
    } : undefined;
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
                footer={<SourceBoardActions item={item} project={null} context={context} onStartWorktree={() => undefined} onChanged={refreshItem} worktreeAvailable={false} stack={stack} branchWriteAccess={detail.status === 'ready' ? detail.value.branchWriteAccess : undefined} />}
                onOpenStackLayer={(layer) => { showTrackerItem(layer.url, directory); }}
                onOpenChecks={pull && context ? () => setChecksOpen(true) : undefined}
                onRefresh={context ? refreshFromHost : undefined}
                onSaveText={saveText}
                threadActions={threadActions}
                commentActions={commentActions}
                stateMenu={writeContext && canChangeReferenceState(reference, detail.status === 'ready' ? detail.value : null) ? (
                    <SourceBoardStateMenuItems item={item} context={writeContext} writeAccess={detail.status === 'ready' ? detail.value.writeAccess : undefined} onChanged={() => void refreshItem()} />
                ) : undefined}
                commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
                labelsControl={writeContext ? <SourceBoardLabels reference={reference} context={writeContext} onChanged={refreshItem} /> : undefined}
                assigneesControl={reference.kind === 'issue' && reference.linked !== true && writeContext ? (
                    <SourceBoardAssignees issue={reference} detail={detail} writeAccess={detail.status === 'ready' ? detail.value.writeAccess : undefined} context={writeContext} onChanged={refreshItem} />
                ) : undefined}
                reviewersControl={pull && writeContext ? (
                    <SourceBoardReviewerPicker pull={pull} detail={detail} context={writeContext} onChanged={refreshItem} />
                ) : undefined}
                reply={writeContext && (detail.status !== 'ready' || detail.value.discussion?.canComment !== false)
                    ? <SourceBoardReply reference={reference} context={writeContext} onRefresh={refreshItem} />
                    : undefined}
                pullLinks={pull && context ? (
                    <SourceBoardPullLinks
                        pull={pull}
                        project={{ id: activeProjectId ?? '', path: directory }}
                        repository={readDirectory}
                        context={context}
                        projectOwnsDirectory={() => !foreign}
                        currentDirectory={panelDirectory}
                        writeAccess={detail.status === 'ready' ? detail.value.writeAccess : undefined}
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
    const { detail, refresh, refreshFromHost, followed } = useTrackerItemDetail(source === 'ready' ? { provider, id: identifier, identifier } : null, true);
    useTrackedItems(visible ? followed : NO_FOLLOWED);
    const showTrackerItem = useShowTrackerItem();
    const now = useMinuteTickerNow(true);

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
            onOpenTrackerItem={(child) => { showTrackerItem(child.url, null); }}
            onRefresh={refreshFromHost}
        />
    );
};
