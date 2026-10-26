/**
 * The issues and pull requests board: a full page over the chat area that
 * lists a project's repository items (on whichever provider hosts it)
 * or a tracker's work items (Linear issues), previews the highlighted one and
 * acts on it.
 *
 * The board keeps its own project. It opens on the one it was left on and
 * switching it never changes the project the rest of the app shows; only an
 * action that opens something in a project (a session, its changes) moves the
 * app there.
 *
 * A project whose folder is not a repository but holds some is read through
 * one of them, chosen beside the project picker; the board's choice is its
 * own and leaves the Git screen's selection alone.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import { IDLE_PULL_STATUS, readyValue, useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import {
    canChangeDiscussionState,
    DEFAULT_REPOSITORY_FILTER,
    REPOSITORY_KIND_ICONS,
    referenceNumberLabel,
    referencePickerItemKey,
    repositoryKindOfTab,
    repositoryKindTabs,
    trackerOfSource,
    trackerReferenceSource,
    type ReferencePickerItem,
    type ReferencePickerSelection,
} from '@/components/references/referencePickerItems';
import { itemDirectory } from '@/components/references/acrossRepositories';
import { forgetRepositoryPullStatus, forgetRepositoryPullStatuses, useRepositoryAcrossReferenceList, useTrackerItemDetail, useRepositoryHostProvider, useRepositoryReadContext, useRepositoryReferenceList } from '@/components/references/referenceSources';
import { openExternalUrl } from '@/lib/url';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    ProjectEntry,
    PullRequestStackLayer,
    RepositoryReference,
    RepositoryReferenceKind,
    SourceControlReadContext,
    TrackerDescriptor,
    TrackerMappingResult,
} from '@/lib/api/types';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { cn } from '@/lib/utils';
import { resolveTrackerMappedProjectPath } from '@/lib/trackers/projectMapping';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { useTrackerSources, useTrackerSourcesPending } from '@/lib/trackers/sources';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { isTrackedWorkItem, type TrackedItem } from '@/lib/trackedItems/model';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { currentTrackerAccountId, isTrackerConnected, useTrackerAuthEntry } from '@/stores/useTrackerAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardChoice, useSourceBoardStore, type SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { SourceBoardActions, SourceBoardPullLinks, SourceBoardStateMenuItems, type SourceBoardProject } from './SourceBoardActions';
import { SourceBoardTrackerStatus } from './SourceBoardTrackerStatus';
import { SourceBoardReply } from './SourceBoardReply';
import { SourceBoardAcrossNote } from './SourceBoardAcrossNote';
import { SourceBoardChecksDialog } from './SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from './SourceBoardMetaEditors';
import { SourceBoardContainerPicker, SourceBoardProjectPicker, SourceBoardRepositoryPicker } from './SourceBoardPickers';
import { choiceForFocus, resolveBoardTab, shouldRememberAll, useBoardRepository } from './boardRepository';
import { isSameRepositoryItemLink } from './openTrackerItem';
import { usePullAttachments } from './pullAttachments';
import { useThreadActions } from './threadActions';
import { useBoardRevalidation } from './useBoardRevalidation';

const NO_REPOSITORIES: readonly string[] = [];
const NO_FOLLOWED: TrackedItem[] = [];
const LIST_MIN_WIDTH = 280;
/** Below this the list leaves its column for a dropdown, so the preview keeps the width. */
const NARROW_BOARD_WIDTH = 960;
const LIST_MAX_FRACTION = 0.6;

const openIntegrationsSettings = () => {
    const ui = useUIStore.getState();
    ui.setSettingsPage('integrations');
    ui.setSettingsDialogOpen(true);
};

/**
 * A tracker's containers (Linear teams) and which project each one works in,
 * read once per open, tracker and account; null where the tracker has no
 * project mapping or until it answers.
 */
function useTrackerMapping(provider: string | null, enabled: boolean): TrackerMappingResult | null {
    const { trackers } = useRuntimeAPIs();
    const mapsProjects = useTrackerDescriptor(provider).capabilities.projectMapping;
    const accountId = currentTrackerAccountId(useTrackerAuthEntry(provider));
    const scope = provider ? `${provider}:${accountId}` : '';
    const [loaded, setLoaded] = React.useState<{ scope: string; mapping: TrackerMappingResult } | null>(null);
    React.useEffect(() => {
        if (!enabled || !provider || !mapsProjects || !trackers) return;
        let cancelled = false;
        void trackers.mappingGet(provider)
            .then((mapping) => { if (!cancelled) setLoaded({ scope, mapping }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [enabled, mapsProjects, provider, scope, trackers]);
    return loaded && loaded.scope === scope ? loaded.mapping : null;
}

/**
 * Once opened, the board stays mounted and is only hidden while closed, so it
 * reopens exactly where it was left however it was opened: the item, the
 * search, the list and preview scrolled where they were, a reply half typed.
 */
export const SourceBoardView: React.FC = () => {
    const open = useUIStore((state) => state.isSourceBoardOpen);
    const [opened, setOpened] = React.useState(open);
    if (open && !opened) setOpened(true);
    // The search took focus when it mounted; a reopen gives it back, as before.
    const boardRef = React.useRef<HTMLDivElement>(null);
    const wasOpenRef = React.useRef(open);
    React.useEffect(() => {
        if (open && !wasOpenRef.current) boardRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
        wasOpenRef.current = open;
    }, [open]);
    if (!opened) return null;
    return (
        <div
            ref={boardRef}
            className={cn('absolute inset-0 z-10 flex flex-col bg-background', !open && 'invisible')}
            inert={!open || undefined}
        >
            {/* Inside the overlay, so a crash shows its fallback in the board's
                place, with its own way to try again. */}
            <ErrorBoundary><SourceBoard layout="desktop" /></ErrorBoundary>
        </div>
    );
};

/**
 * The board as the phone shell's page: one column, the preview in place of
 * the list, and `onLeave` once a session starts so the chat comes back. It
 * draws its own header, so the project picker and the way back from an item
 * share the close button's row.
 */
export const MobileSourceBoard: React.FC<{ onLeave: () => void; onClose: () => void }> = ({ onLeave, onClose }) => (
    <div className="flex h-full min-h-0 flex-col">
        <SourceBoard layout="mobile" onLeave={onLeave} onClose={onClose} />
    </div>
);

/** The phone page's header: close, or back from an item, then what the page is on. */
const MobileBoardHeader: React.FC<{ onClose?: () => void; onBack?: () => void; children?: React.ReactNode }> = ({ onClose, onBack, children }) => {
    const { t } = useI18n();
    const action = onBack ?? onClose;
    return (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/70 px-3">
            {action ? (
                <button
                    type="button"
                    className="-ms-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={onBack ? t('references.picker.actions.back') : t('mobile.surface.closeAria')}
                    onClick={action}
                    style={{ touchAction: 'manipulation' }}
                >
                    <Icon name={onBack ? 'arrow-left-s' : 'close'} className="size-5" />
                </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center">{children}</div>
        </header>
    );
};

type SourceBoardLayout = 'desktop' | 'mobile';

/** What the board lists: the repository's issues, change requests or discussions, or one tracker's items. */
type SourceBoardKind = RepositoryReferenceKind | `tracker:${string}`;

const SourceBoard: React.FC<{ layout: SourceBoardLayout; onLeave?: () => void; onClose?: () => void }> = ({ layout, onLeave, onClose }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    // Only signed-in trackers get a tab; connecting one happens in Settings.
    const trackerTabs = useTrackerSources();
    const trackersPending = useTrackerSourcesPending();
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const choice = useSourceBoardChoice();
    const updateChoice = useSourceBoardStore((state) => state.update);
    // The repository tab to land on when switching back from a tracker.
    const [repositoryKind, setRepositoryKind] = React.useState<RepositoryReferenceKind | undefined>(undefined);
    // The phone's board page is mounted only while shown.
    const desktopBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
    const onScreen = layout === 'mobile' || desktopBoardOpen;
    useBoardRevalidation(onScreen);

    // The remembered project while it still exists, else the app's own.
    const project = projects.find((entry) => entry.id === choice.projectId)
        ?? projects.find((entry) => entry.id === activeProjectId)
        ?? projects[0]
        ?? null;
    const projectRoot = project ? normalizeProjectPath(project.path) : null;
    // The folder everything below reads from: the project's root, or the
    // repository under it when the root is not one.
    // A link another surface asked to show is looked up across the folder's repositories.
    const focusPending = useSourceBoardStore((state) => state.repositoryFocus !== null);
    const storedAll = project ? choice.allRepositoriesByProject[project.id] : undefined;
    const repository = useBoardRepository(projectRoot, choiceForFocus({
        path: project ? choice.repositoryByProject[project.id] ?? null : null,
        all: storedAll,
    }, focusPending));
    const projectId = project?.id;
    const rememberAll = shouldRememberAll(repository, storedAll, focusPending);
    React.useEffect(() => {
        if (rememberAll && projectId) updateChoice({ allRepositoriesByProject: { [projectId]: true } });
    }, [projectId, rememberAll, updateChoice]);
    const directory = repository.directory;
    // Across the repositories under the folder: the provider that search asks is decided per list.
    const allRepositories = repository.all ? repository.repositories : null;
    const hostProvider = useRepositoryHostProvider(allRepositories ? null : directory);
    const hasRepository = allRepositories !== null || (hostProvider !== 'none' && hostProvider !== null);
    const connectedTrackers = React.useMemo(() => trackerTabs.map((descriptor) => descriptor.id), [trackerTabs]);
    const tab = resolveBoardTab({
        chosen: choice.tab,
        hasRepository,
        repositoryStatus: repository.status,
        trackers: { connected: connectedTrackers, pending: trackersPending },
    });
    const tracker = tab ? trackerOfSource(tab) : null;

    const trackerConnected = isTrackerConnected(useTrackerAuthEntry(tracker));
    const mapping = useTrackerMapping(tracker, trackerConnected);
    const containers = mapping?.connected ? mapping.containers : [];
    const storedContainerId = tracker ? choice.trackerContainerByProvider[tracker] ?? null : null;
    const containerId = storedContainerId && containers.some((container) => container.id === storedContainerId) ? storedContainerId : null;

    const projectPicker = project ? (
        <SourceBoardProjectPicker
            projects={projects}
            selected={project}
            onSelect={(projectId) => updateChoice({ projectId, tab: 'repository' })}
            ariaLabel={t('sourceBoard.project.label')}
            size="toolbar"
            sheet={layout === 'mobile'}
        />
    ) : null;
    const repositoryPicker = projectRoot && directory && repository.repositories.length > 0 ? (
        <SourceBoardRepositoryPicker
            repositories={repository.repositories}
            selected={allRepositories ? null : directory}
            root={projectRoot}
            allAvailable={Boolean(sourceControl.referencesAcross)}
            onSelect={(repositoryPath) => {
                if (!project) return;
                updateChoice(repositoryPath === null
                    ? { allRepositoriesByProject: { [project.id]: true }, tab: 'repository' }
                    : { repositoryByProject: { [project.id]: repositoryPath }, allRepositoriesByProject: { [project.id]: false }, tab: 'repository' });
            }}
            sheet={layout === 'mobile'}
        />
    ) : null;
    const projectScope = <>{projectPicker}{repositoryPicker}</>;
    // On a tracker the board lists a container (a Linear team). The project's
    // pickers stay beside it when the project offers no repository tab, the
    // only other way off the tracker.
    const scopePicker = tracker ? (
        <>
            {hasRepository ? null : projectScope}
            <SourceBoardContainerPicker
                provider={tracker}
                containers={containers}
                selectedContainerId={containerId}
                onSelectContainer={(next) => updateChoice({ trackerContainerByProvider: { [tracker]: next } })}
                onAccountSwitched={() => updateChoice({ trackerContainerByProvider: { [tracker]: null } })}
            />
        </>
    ) : projectScope;

    const selectKind = (kind: SourceBoardKind) => {
        if (kind.startsWith('tracker:')) {
            updateChoice({ tab: trackerReferenceSource(kind.slice('tracker:'.length)) });
            return;
        }
        setRepositoryKind(repositoryKindOfTab(kind));
        updateChoice({ tab: 'repository' });
    };

    if (!tab) {
        return (
            <>
                {layout === 'mobile' ? (
                    <MobileBoardHeader onClose={onClose}>{projectScope}</MobileBoardHeader>
                ) : (
                    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">{projectScope}</div>
                )}
                {repository.status === 'ready' && !trackersPending ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center typography-meta text-muted-foreground">
                        <span>{t(projects.length === 0 ? 'sourceBoard.empty.noProjects' : 'sourceBoard.empty.noSource')}</span>
                        {projects.length > 0 ? (
                            <Button size="sm" variant="outline" onClick={openIntegrationsSettings}>{t('references.picker.actions.openSettings')}</Button>
                        ) : null}
                    </div>
                ) : (
                    // Looking for the folder's repositories or asking the trackers
                    // whether they are connected, or unable to: none says there is nothing.
                    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center typography-meta text-muted-foreground">
                        {repository.status !== 'failed' ? <Icon name="loader-4" className="size-5 animate-spin" /> : null}
                        {repository.status !== 'ready' ? (
                            <span>{t(repository.status === 'failed' ? 'gitView.empty.discoverFailed' : 'gitView.empty.discoveringRepositories')}</span>
                        ) : null}
                        {repository.status === 'failed' ? (
                            <Button size="sm" variant="outline" onClick={repository.retry}>
                                <Icon name="refresh" className="size-3.5" />
                                {t('gitView.empty.retryDiscovery')}
                            </Button>
                        ) : null}
                    </div>
                )}
            </>
        );
    }

    return (
        // Remounted per source and project: a new list starts with an empty search.
        <SourceBoardBody
            key={`${tab}:${tab === 'repository' ? `${allRepositories ? 'all:' : ''}${directory}` : containerId ?? ''}`}
            tab={tab}
            project={project}
            directory={directory}
            allRepositories={allRepositories}
            trackerContainerId={containerId}
            mapping={mapping}
            projects={projects}
            scopePicker={scopePicker}
            kinds={{ repository: hasRepository ? { provider: allRepositories || hostProvider === 'none' ? null : hostProvider } : null, trackers: trackerTabs }}
            initialRepositoryKind={repositoryKind}
            onSelectKind={selectKind}
            layout={layout}
            onScreen={onScreen}
            onLeave={onLeave}
            onClose={onClose}
        />
    );
};

const SourceBoardBody: React.FC<{
    tab: SourceBoardTab;
    project: ProjectEntry | null;
    /** The folder the board reads; the project's root while it lists `allRepositories`. */
    directory: string | null;
    /** The repositories listed together, or null while one folder is read. */
    allRepositories: readonly string[] | null;
    /** The tracker container (Linear team) a tracker tab lists; null lists every one. */
    trackerContainerId: string | null;
    mapping: TrackerMappingResult | null;
    projects: ProjectEntry[];
    scopePicker: React.ReactNode;
    /**
     * The tabs this project offers: its repository host's, and one per
     * tracker. The provider is null across repositories, where each list
     * names its own.
     */
    kinds: { repository: { provider: string | null } | null; trackers: readonly TrackerDescriptor[] };
    initialRepositoryKind?: RepositoryReferenceKind;
    onSelectKind: (kind: SourceBoardKind) => void;
    layout: SourceBoardLayout;
    /** False while the desktop board is kept mounted but closed: nothing it lists is followed then. */
    onScreen: boolean;
    onLeave?: () => void;
    /** The phone page's close button. */
    onClose?: () => void;
}> = ({ tab, project, directory, allRepositories, trackerContainerId, mapping, projects, scopePicker, kinds, initialRepositoryKind, onSelectKind, layout, onScreen, onLeave, onClose }) => {
    const isMobile = layout === 'mobile';
    const { t } = useI18n();
    const { sourceControl, trackers } = useRuntimeAPIs();
    const tracker = trackerOfSource(tab);
    // An item another surface asked to show: an issue or PR by its link, a
    // tracker item by its identifier. It is read on its own, not typed into the
    // search: the list stays as it was, and the preview opens on the item.
    const [pinnedLink, setPinnedLink] = React.useState<{ kind: RepositoryReferenceKind; url: string } | null>(null);
    const [pinnedTrackerId, setPinnedTrackerId] = React.useState<string | null>(null);
    // Counts the requests to show an item, so each is shown once, and the one
    // shown before never answers for the one just asked.
    const [pinRequest, setPinRequest] = React.useState(0);
    const pinnedSingle = useRepositoryReferenceList({
        enabled: tab === 'repository' && pinnedLink !== null && allRepositories === null,
        directory,
        kind: pinnedLink?.kind ?? 'issue',
        filter: DEFAULT_REPOSITORY_FILTER,
        query: pinnedLink?.url ?? '',
    });
    const pinnedAcross = useRepositoryAcrossReferenceList({
        enabled: tab === 'repository' && pinnedLink !== null && allRepositories !== null,
        directories: allRepositories ?? NO_REPOSITORIES,
        kind: pinnedLink?.kind ?? 'issue',
        filter: DEFAULT_REPOSITORY_FILTER,
        query: pinnedLink?.url ?? '',
    });
    const pinnedLookup = allRepositories ? pinnedAcross : pinnedSingle;
    // A tracker's get takes its human identifier as well as its own id.
    const { detail: pinnedTracker, followed: pinnedTrackerFollowed } = useTrackerItemDetail(
        tracker && pinnedTrackerId ? { provider: tracker, id: pinnedTrackerId } : null,
        true,
    );
    const urls = useRepositoryUrlMatcher();
    // Only the item the link names: a lookup that fell back to a search lists others.
    const namesPinnedLink = (item: RepositoryReference) => pinnedLink !== null && isSameRepositoryItemLink(item.url, pinnedLink.url, urls);
    const pinnedAcrossItem = tab === 'repository' && allRepositories ? pinnedAcross.items.find(namesPinnedLink) ?? null : null;
    const pinnedReference = tab === 'repository' && !allRepositories ? pinnedSingle.items.find(namesPinnedLink) ?? null : pinnedAcrossItem;
    // Across repositories the item names the folder it was read through.
    const pinnedFolder = pinnedAcrossItem?.directory;
    const pinnedTrackerItem = tracker && pinnedTracker.status === 'ready' ? pinnedTracker.value : null;
    const pinnedItem = React.useMemo<ReferencePickerItem | null>(() => {
        if (pinnedReference) return { source: 'repository', reference: pinnedReference, directory: pinnedFolder };
        if (pinnedTrackerItem) return { source: 'tracker', provider: pinnedTrackerItem.provider, item: pinnedTrackerItem };
        return null;
    }, [pinnedFolder, pinnedTrackerItem, pinnedReference]);
    const browser = useReferenceBrowser({
        source: tab,
        directory: tracker ? null : directory,
        directories: tracker ? null : allRepositories,
        isMobile,
        trackerContainerId,
        initialGitHubKind: initialRepositoryKind,
        pinnedItem,
        onScreen,
    });
    // The item a link asked to show is followed like a listed one; a lookup
    // that fell back to a search lists others, which are not.
    const pinnedFollowed = React.useMemo(() => (pinnedItem?.source === 'tracker'
        ? pinnedTrackerFollowed
        : pinnedLookup.followed.filter((item) => !isTrackedWorkItem(item) && item.number === pinnedReference?.number)
    ), [pinnedItem, pinnedTrackerFollowed, pinnedLookup.followed, pinnedReference]);
    useTrackedItems(onScreen && pinnedItem ? pinnedFollowed : NO_FOLLOWED);
    const { previewItem, setQuery, selectRepositoryKind, showItem } = browser;
    const shownPinRequestRef = React.useRef(0);
    const trackerFocus = useSourceBoardStore((state) => (
        tracker && state.trackerFocus?.provider === tracker ? state.trackerFocus.identifier : null
    ));
    React.useEffect(() => {
        if (!trackerFocus) return;
        setPinRequest((request) => request + 1);
        setQuery('');
        setPinnedTrackerId(trackerFocus);
        useSourceBoardStore.getState().clearTrackerFocus();
    }, [trackerFocus, setQuery]);
    const repositoryFocus = useSourceBoardStore((state) => (tab === 'repository' ? state.repositoryFocus : null));
    React.useEffect(() => {
        if (!repositoryFocus) return;
        setPinRequest((request) => request + 1);
        selectRepositoryKind(repositoryFocus.kind);
        setQuery('');
        setPinnedLink({ kind: repositoryFocus.kind, url: repositoryFocus.query });
        useSourceBoardStore.getState().clearRepositoryFocus();
    }, [repositoryFocus, selectRepositoryKind, setQuery]);
    // Shown once found; the user then moves on from it like from any row. The
    // commit that takes a new request still holds the previous item, and the
    // previous request was already shown, so it is not shown over again.
    React.useEffect(() => {
        if (!pinnedItem || shownPinRequestRef.current === pinRequest) return;
        shownPinRequestRef.current = pinRequest;
        showItem(referencePickerItemKey(pinnedItem));
    }, [pinRequest, pinnedItem, showItem]);
    // Not found: a link the project's host does not know opens in the browser;
    // a tracker identifier is searched for instead.
    const pinnedLinkStatus = pinnedLookup.status;
    React.useEffect(() => {
        if (!pinnedLink || pinnedLinkStatus === 'loading' || pinnedReference) return;
        void openExternalUrl(pinnedLink.url);
        setPinnedLink(null);
    }, [pinnedLink, pinnedLinkStatus, pinnedReference]);
    const pinnedTrackerStatus = pinnedTracker.status;
    React.useEffect(() => {
        if (!pinnedTrackerId || pinnedTrackerStatus !== 'error') return;
        setQuery(pinnedTrackerId);
        setPinnedTrackerId(null);
    }, [pinnedTrackerId, pinnedTrackerStatus, setQuery]);
    const currentDirectory = useEffectiveDirectory();
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    // New Worktree opens on the previewed item, or on a new branch on top of a PR's.
    const [worktreeRequest, setWorktreeRequest] = React.useState<
        | { project: SourceBoardProject; selection: ReferencePickerSelection; onTopOf?: undefined }
        | { project: SourceBoardProject; selection?: undefined; onTopOf: string }
        | null
    >(null);
    // Another layer of the previewed PR's stack opens here, read on its own like a link.
    const openStackLayer = React.useCallback((layer: PullRequestStackLayer) => {
        setPinRequest((request) => request + 1);
        setPinnedLink({ kind: 'pull', url: layer.url });
    }, []);

    // A tracker item starts in its container's project, else the mapping's default,
    // else the project the board was last on; the user can pick another.
    const [trackerProjectChoice, setTrackerProjectChoice] = React.useState<{ itemKey: string; projectId: string } | null>(null);
    const trackerItemKey = previewItem?.source === 'tracker' ? referencePickerItemKey(previewItem) : null;
    const trackerProjectOverride = trackerProjectChoice && trackerProjectChoice.itemKey === trackerItemKey ? trackerProjectChoice.projectId : null;
    const mappedPath = previewItem?.source === 'tracker' ? resolveTrackerMappedProjectPath(mapping, previewItem.item.container) : null;
    const mappedProject = mappedPath ? projects.find((entry) => normalizeProjectPath(entry.path) === normalizeProjectPath(mappedPath)) ?? null : null;
    const actionProjectEntry = tracker
        ? projects.find((entry) => entry.id === trackerProjectOverride) ?? mappedProject ?? project
        : project;
    const actionPath = actionProjectEntry ? normalizeProjectPath(actionProjectEntry.path) : null;
    const actionProject: SourceBoardProject | null = actionProjectEntry && actionPath ? { id: actionProjectEntry.id, path: actionPath } : null;
    // A tracker item is read nowhere; an issue or PR is acted on in the repository it was listed from.
    // An item of a repository under a root that is not one: the project itself is no repository to branch from.
    const readsNestedRepository = tab === 'repository'
        && (allRepositories !== null || (actionPath !== null && directory !== null && directory !== actionPath));
    // An item is read and acted on through the folder it came from: its repository's, across several.
    const readFolder = tracker
        ? actionProject?.path ?? null
        : allRepositories ? itemDirectory(previewItem, null) : directory;
    const actionContext = useRepositoryReadContext(readFolder);
    const context: SourceControlReadContext | null = actionContext && actionContext !== 'missing' ? actionContext : null;

    const projectOwnsDirectory = React.useCallback((candidate: string | undefined) => {
        if (!candidate || !actionProjectEntry) return false;
        return resolveProjectForSessionDirectory(projects, worktreesByProject, candidate)?.id === actionProjectEntry.id;
    }, [actionProjectEntry, projects, worktreesByProject]);

    const title = tracker
        ? t('sourceBoard.list.tracker', { provider: browser.trackerDescriptor.name })
        : t(`sourceBoard.list.repository.${browser.term}`, { provider: browser.descriptor.label });
    const previewDescriptor = useSourceControlProvider(previewItem?.source === 'repository' ? previewItem.reference.provider : null);
    // The project's host names the change-request tab; across repositories, the provider the list asks.
    const kindDescriptor = useSourceControlProvider(kinds.repository?.provider);
    const repositoryTerm = kinds.repository?.provider ? kindDescriptor.terminology.changeRequest : browser.term;
    const repositoryDiscussions = kinds.repository?.provider ? kindDescriptor.features.discussions : browser.discussions;

    // Where a tracker item's session starts, changeable for that item.
    const startIn = tracker && actionProjectEntry ? (
        <span className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
            {t('sourceBoard.tracker.startIn')}
            <SourceBoardProjectPicker
                projects={projects}
                selected={actionProjectEntry}
                onSelect={(projectId) => { if (trackerItemKey) setTrackerProjectChoice({ itemKey: trackerItemKey, projectId }); }}
                ariaLabel={t('sourceBoard.tracker.startIn')}
                size="inline"
                sheet={isMobile}
            />
        </span>
    ) : null;

    // The latest revision's detail names the revisions, the votes and what submission needs, whichever one is shown.
    const latestPull = previewItem?.source === 'repository' && browser.repositoryLatestDetail.status === 'ready'
        ? browser.repositoryLatestDetail.value.pull
        : null;
    // The listed change's status says whether the host would submit it.
    const previewPullStatus = previewItem?.source === 'repository' && previewItem.reference.kind === 'pull'
        ? readyValue(browser.pullStatusOf(previewItem.reference, previewItem.directory))
        : null;
    const actions = previewItem ? (
        <SourceBoardActions
            item={previewItem}
            project={actionProject}
            context={context}
            onStartWorktree={(target, selection) => setWorktreeRequest({ project: target, selection })}
            onChanged={browser.list.retry}
            startIn={startIn}
            onLeave={onLeave}
            worktreeAvailable={!readsNestedRepository}
            stack={previewItem?.source === 'repository' && browser.repositoryDetail.status === 'ready' ? browser.repositoryDetail.value.pull?.stack ?? null : null}
            onStartOnTop={actionProject ? (pull) => setWorktreeRequest({ project: actionProject, onTopOf: pull.head }) : undefined}
            submitRequirements={latestPull?.submitRequirements}
            submitRequirementsUnreadable={previewItem?.source === 'repository' && browser.repositoryLatestDetail.status === 'error'}
            mergeable={previewPullStatus?.mergeable ?? null}
        />
    ) : null;

    const attachments = usePullAttachments(previewItem?.source === 'repository' ? previewItem.reference : null);

    // The previewed PR's check runs, opened from its checks totals.
    const [checksOpenFor, setChecksOpenFor] = React.useState<string | null>(null);
    const previewPull = previewItem?.source === 'repository' && previewItem.reference.kind === 'pull' ? previewItem.reference : null;
    const previewKey = previewItem ? referencePickerItemKey(previewItem) : null;
    const checksDialog = previewPull && context ? (
        <SourceBoardChecksDialog
            pull={previewPull}
            context={context}
            open={checksOpenFor !== null && checksOpenFor === previewKey}
            onOpenChange={(open) => setChecksOpenFor(open ? previewKey : null)}
            onAttachFailed={attachments.attachFailedChecks}
        />
    ) : null;

    // What this account may do with the previewed discussion, once its detail says.
    const previewDiscussion = previewItem?.source === 'repository' && previewItem.reference.kind === 'discussion' && browser.repositoryDetail.status === 'ready'
        ? browser.repositoryDetail.value.discussion
        : undefined;

    // After a change to an issue or PR: its detail and the list read again.
    const { refreshRepositoryDetail, list: { retry: retryList } } = browser;
    const refreshRepositoryItem = React.useCallback(
        () => Promise.all([refreshRepositoryDetail(), retryList()]).then(() => undefined),
        [refreshRepositoryDetail, retryList],
    );
    const threadActions = useThreadActions(previewItem?.source === 'repository' ? previewItem.reference : null, context, refreshRepositoryItem);
    // The preview's refresh button, for a change made on the host's own site,
    // which the server's short-lived answers would otherwise hide for up to
    // half a minute: the shown item alone, its state and checks included.
    const refreshFromHost = async () => {
        if (context && previewItem?.source === 'repository') {
            const { sourceRepo, number } = previewItem.reference;
            const item = { owner: sourceRepo.owner, repo: sourceRepo.repo, number };
            await sourceControl.refreshProviderReads(context, { item }).catch(() => undefined);
            forgetRepositoryPullStatus(item);
        }
        await refreshRepositoryDetail();
    };

    // The list's refresh button: what is listed, and the checks of its PRs, read
    // again, such as a PR just opened on the host's own site.
    const listContextValue = useRepositoryReadContext(tracker ? null : allRepositories?.[0] ?? directory);
    const listContext = listContextValue && listContextValue !== 'missing' ? listContextValue : null;
    const [listRefreshing, setListRefreshing] = React.useState(false);
    const refreshList = async () => {
        if (listRefreshing) return;
        setListRefreshing(true);
        try {
            if (tracker) {
                await trackers?.refreshListReads(tracker).catch(() => undefined);
            } else {
                if (listContext) await sourceControl.refreshProviderReads(listContext, { lists: true }).catch(() => undefined);
                forgetRepositoryPullStatuses();
            }
            await retryList();
        } finally {
            setListRefreshing(false);
        }
    };
    const listRefreshButton = (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('shrink-0 px-0', isMobile ? 'size-8' : 'size-7')}
            aria-label={t('sourceBoard.list.refresh')}
            title={t('sourceBoard.list.refresh')}
            disabled={listRefreshing}
            onClick={() => void refreshList()}
        >
            <Icon name="refresh" className={cn('size-4', listRefreshing && 'animate-spin')} />
        </Button>
    );

    const preview = (
        <ReferencePreview
            item={previewItem}
            directory={itemDirectory(previewItem, browser.directory)}
            pullStatus={previewItem?.source === 'repository' ? browser.pullStatusOf(previewItem.reference, previewItem.directory) : IDLE_PULL_STATUS}
            trackerDetail={browser.trackerDetail}
            repositoryDetail={browser.repositoryDetail}
            purpose="attach"
            pinned={!isMobile}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={browser.now}
            footer={actions}
            trackerStateControl={previewItem?.source === 'tracker' ? <SourceBoardTrackerStatus item={previewItem.item} onChanged={browser.list.retry} /> : undefined}
            onOpenTrackerItem={(item) => browser.openItem({ source: 'tracker', provider: item.provider, item })}
            onOpenStackLayer={openStackLayer}
            revisionChoice={latestPull?.revisions ? { revisions: latestPull.revisions, selected: browser.previewRevision, onSelect: browser.selectPreviewRevision } : undefined}
            onOpenChecks={previewPull && context ? () => setChecksOpenFor(previewKey) : undefined}
            onRefresh={previewItem?.source === 'repository' && context ? refreshFromHost : undefined}
            threadActions={threadActions}
            stateMenu={previewItem?.source === 'repository' && previewItem.reference.state !== 'merged' && context
                && (previewItem.reference.kind !== 'discussion' || canChangeDiscussionState(previewItem.reference, previewDiscussion)) ? (
                <SourceBoardStateMenuItems item={previewItem} context={context} onChanged={refreshRepositoryItem} />
            ) : undefined}
            commentAttachments={previewItem?.source === 'repository'
                ? { onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }
                : undefined}
            labelsControl={previewItem?.source === 'repository' && context ? (
                <SourceBoardLabels key={referencePickerItemKey(previewItem)} reference={previewItem.reference} context={context} onChanged={refreshRepositoryItem} />
            ) : undefined}
            reviewersControl={previewItem?.source === 'repository' && previewItem.reference.kind === 'pull' && context ? (
                <SourceBoardReviewers
                    key={referencePickerItemKey(previewItem)}
                    pull={previewItem.reference}
                    detail={browser.repositoryDetail}
                    context={context}
                    onChanged={refreshRepositoryItem}
                />
            ) : undefined}
            // Keyed by the item: a draft never carries over to another one.
            // A locked discussion takes no comment from someone who may not update it.
            reply={previewItem?.source === 'repository' && context && previewDiscussion?.canComment !== false ? (
                <SourceBoardReply
                    key={referencePickerItemKey(previewItem)}
                    reference={previewItem.reference}
                    context={context}
                    onRefresh={refreshRepositoryItem}
                    voteLabels={latestPull?.voteLabels}
                    latestRevision={latestPull?.revisions?.at(-1)?.sha}
                    onLatestRevision={browser.previewRevision === null}
                />
            ) : undefined}
            pullLinks={previewItem?.source === 'repository' && previewItem.reference.kind === 'pull' && actionProject && context ? (
                <SourceBoardPullLinks
                    pull={previewItem.reference}
                    project={actionProject}
                    repository={tab === 'repository' ? readFolder : null}
                    context={context}
                    projectOwnsDirectory={projectOwnsDirectory}
                    currentDirectory={currentDirectory}
                    onLeave={onLeave}
                    revision={browser.previewRevision}
                />
            ) : null}
        />
    );

    // A narrow board (the side panel beside it, a small window) shows the list
    // as a dropdown under the toolbar instead of a column.
    const boardRef = React.useRef<HTMLDivElement>(null);
    const [narrow, setNarrow] = React.useState(false);
    const [listOpen, setListOpen] = React.useState(false);
    React.useLayoutEffect(() => {
        const board = boardRef.current;
        if (!board) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setNarrow(entry.contentRect.width < NARROW_BOARD_WIDTH);
        });
        observer.observe(board);
        return () => observer.disconnect();
    }, []);
    const listDropdown = narrow && listOpen;

    const list = (
        <ReferenceBrowserList
            browser={browser}
            label={title}
            multiselectable={false}
            onOpenSettings={openIntegrationsSettings}
            onShow={() => setListOpen(false)}
            notice={browser.across && directory ? <SourceBoardAcrossNote leftOut={browser.leftOut} root={directory} askedProvider={browser.acrossProvider} /> : null}
        />
    );
    const search = (
        <ReferenceBrowserSearch
            browser={browser}
            trailing={listRefreshButton}
            onKeyDown={(event) => {
                if (narrow) {
                    // Typing or arrows show the results; Enter keeps the one picked.
                    if (event.key === 'Enter' || event.key === 'Escape') {
                        if (listOpen && event.key === 'Escape') event.stopPropagation();
                        setListOpen(false);
                    } else if (event.key.length === 1 || event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Backspace') {
                        setListOpen(true);
                    }
                }
                browser.handleNavigationKey(event);
            }}
        />
    );
    const itemLabel = previewItem
        ? previewItem.source === 'tracker' ? previewItem.item.identifier : referenceNumberLabel(previewItem.reference, previewDescriptor)
        : t('sourceBoard.list.choose');
    const itemIcon = tracker ? trackerPresentation(tracker).icon : REPOSITORY_KIND_ICONS[browser.repositoryKind];
    const itemTrigger = (
        <button
            type="button"
            className={cn(dropdownTriggerVariants(), 'shrink-0 gap-1.5')}
            aria-expanded={listDropdown}
            aria-label={t('sourceBoard.list.toggleAria', { item: itemLabel })}
            data-popup-open={listDropdown ? '' : undefined}
            onClick={() => setListOpen((open) => !open)}
        >
            <Icon name={itemIcon} className="size-3.5" />
            <span className="tabular-nums">{itemLabel}</span>
            <Icon name="arrow-down-s" className="size-4 opacity-70" />
        </button>
    );

    const worktreeDialog = (
        <NewWorktreeDialog
            open={worktreeRequest !== null}
            onOpenChange={(next) => { if (!next) setWorktreeRequest(null); }}
            project={worktreeRequest?.project}
            initialSelection={worktreeRequest?.selection}
            initialSourceBranch={worktreeRequest?.onTopOf}
            onWorktreeCreated={(worktreePath) => {
                useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: worktreePath, preserveDirectoryOverride: true });
                onLeave?.();
            }}
        />
    );

    const kindItems = [
        ...(kinds.repository
            ? repositoryKindTabs(t, repositoryTerm, repositoryDiscussions).map((tab) => ({ ...tab, icon: <Icon name={tab.icon} className="size-3.5" /> }))
            : []),
        // A tracker tab carries its product name, untranslated.
        ...kinds.trackers.map((descriptor) => ({
            id: trackerReferenceSource(descriptor.id),
            label: descriptor.name,
            icon: <Icon name={trackerPresentation(descriptor.id).icon} className="size-3.5" />,
        })),
    ];
    const kindSwitch = (
        <div className={isMobile ? 'w-full' : 'shrink-0'}>
            <SortableTabsStrip
                items={kindItems}
                activeId={tracker ? tab : browser.repositoryKind}
                onSelect={(id) => {
                    if (id.startsWith('tracker:')) {
                        onSelectKind(trackerReferenceSource(id.slice('tracker:'.length)));
                        return;
                    }
                    const kind = repositoryKindOfTab(id);
                    // From a tracker tab the repository list remounts on the chosen kind.
                    if (tracker) onSelectKind(kind);
                    else browser.selectRepositoryKind(kind);
                }}
                variant="active-pill"
                // Desktop: sized by its labels in a row that gives it no width of its
                // own. Phone: the full row, shared.
                layoutMode={isMobile ? 'fit' : 'scrollable'}
                intrinsicWidth={!isMobile}
                // A narrow board names the kinds by icon; the label is the tooltip.
                iconOnly={narrow}
                activePillButtonClassName={isMobile ? undefined : narrow ? 'px-2.5' : 'px-3'}
            />
        </div>
    );

    // The list column, resized by dragging its edge or with the arrow keys.
    const listWidth = useSourceBoardStore((state) => state.listWidth);
    const splitRef = React.useRef<HTMLDivElement>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    const [resizing, setResizing] = React.useState(false);
    const clampWidth = (width: number) => {
        const max = Math.max(LIST_MIN_WIDTH, (splitRef.current?.clientWidth ?? 0) * LIST_MAX_FRACTION);
        return Math.min(max, Math.max(LIST_MIN_WIDTH, width));
    };
    const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = listRef.current?.offsetWidth ?? LIST_MIN_WIDTH;
        // The list is at the start; in RTL dragging left widens it.
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        setResizing(true);
        const onMove = (move: PointerEvent) => useSourceBoardStore.getState().setListWidth(clampWidth(startWidth + (move.clientX - startX) * sign));
        const onUp = () => {
            setResizing(false);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };
    const resizeWithKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 40 : 10;
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        const delta = (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) * sign;
        if (delta === 0) return;
        event.preventDefault();
        useSourceBoardStore.getState().setListWidth(clampWidth((listRef.current?.offsetWidth ?? LIST_MIN_WIDTH) + delta));
    };

    if (isMobile) {
        const inPreview = Boolean(browser.mobilePreviewKey && previewItem);
        return (
            <>
                {inPreview ? (
                    <MobileBoardHeader onBack={browser.closeMobilePreview}>
                        <h2 className="truncate px-1 typography-ui-label tabular-nums text-foreground">{itemLabel}</h2>
                    </MobileBoardHeader>
                ) : (
                    <>
                        <MobileBoardHeader onClose={onClose}>{scopePicker}</MobileBoardHeader>
                        <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
                            {kindSwitch}
                            {search}
                        </div>
                    </>
                )}
                {/* A crash below keeps the header, the only way to close the page on iOS. */}
                <ErrorBoundary>
                    <ScrollableOverlay outerClassName="min-h-0 flex-1" className={inPreview ? 'px-4 py-3' : undefined} disableHorizontal>
                        {inPreview ? preview : list}
                    </ScrollableOverlay>
                </ErrorBoundary>
                {worktreeDialog}
                {checksDialog}
            </>
        );
    }

    // One row: what is listed (kind, then scope), then how it is narrowed. The
    // kind switch comes first: its width is fixed, while the scope picker's
    // follows the chosen name and would push the switch around.
    return (
        <div ref={boardRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-2 py-2.5">
                {kindSwitch}
                {scopePicker}
                {narrow ? itemTrigger : null}
                {/* Narrow, the search takes a row of its own rather than shrink to a few letters. */}
                {narrow ? <div className="flex min-w-[20rem] flex-1">{search}</div> : search}
            </div>
            {narrow ? (
                <div className="relative min-h-0 flex-1">
                    {preview}
                    {listDropdown ? (
                        <>
                            <div className="absolute inset-0 z-10" aria-hidden onClick={() => setListOpen(false)} />
                            <div className="oc-glass-popover oc-glass-floating absolute inset-x-2 top-1 z-20 flex h-[min(28rem,75%)] flex-col overflow-hidden rounded-xl">
                                <ScrollableOverlay outerClassName="min-h-0 flex-1" disableHorizontal>
                                    {list}
                                </ScrollableOverlay>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : (
            <div ref={splitRef} className="flex min-h-0 flex-1">
                {/* CSS keeps a remembered width inside the board: never under
                    280 px (or half a narrow board, so the preview keeps room),
                    never over 60 % of it. */}
                <div className="min-h-0 min-w-[min(280px,50%)] max-w-[60%] shrink-0" style={{ width: listWidth ?? '41.666%' }} ref={listRef}>
                    <ScrollableOverlay outerClassName="h-full min-h-0" disableHorizontal>
                        {list}
                    </ScrollableOverlay>
                </div>
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sourceBoard.list.resize')}
                    tabIndex={0}
                    onPointerDown={startResize}
                    onKeyDown={resizeWithKeys}
                    className={cn(
                        'relative w-px shrink-0 cursor-col-resize bg-border/60',
                        "before:absolute before:inset-y-0 before:-inset-s-1.5 before:-inset-e-1.5 before:content-['']",
                        'hover:bg-interactive-selection focus-visible:bg-interactive-selection focus-visible:outline-none',
                        resizing && 'bg-interactive-selection',
                    )}
                />
                <div className="min-h-0 min-w-0 flex-1">{preview}</div>
            </div>
            )}
            {worktreeDialog}
            {checksDialog}
        </div>
    );
};
