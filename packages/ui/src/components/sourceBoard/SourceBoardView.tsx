/**
 * The issues and pull requests board: a full page over the chat area that
 * lists a project's repository items (GitHub or GitLab, whichever hosts it)
 * or Linear issues, previews the highlighted one and acts on it.
 *
 * The board keeps its own project. It opens on the one it was left on and
 * switching it never changes the project the rest of the app shows; only an
 * action that opens something in a project (a session, its changes) moves the
 * app there.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import { IDLE_PULL_STATUS, useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { DEFAULT_REPOSITORY_FILTER, referenceNumberLabel, referencePickerItemKey, type ReferencePickerItem, type ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { useGitHubReadContext, useGitHubReferenceList, useLinearIssueDetail, useRepositoryHostProvider } from '@/components/references/referenceSources';
import { openExternalUrl } from '@/lib/url';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubReferenceKind, LinearMappingResult, ProjectEntry, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { resolveLinearMappedProjectPath } from '@/lib/linearProjectMapping';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardChoice, useSourceBoardStore, type SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { SourceBoardActions, SourceBoardPullLinks, SourceBoardStateMenuItems, type SourceBoardProject } from './SourceBoardActions';
import { SourceBoardLinearStatus } from './SourceBoardLinearStatus';
import { SourceBoardReply } from './SourceBoardReply';
import { SourceBoardChecksDialog } from './SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from './SourceBoardMetaEditors';
import { SourceBoardProjectPicker, SourceBoardTeamPicker } from './SourceBoardPickers';
import { usePullAttachments } from './pullAttachments';

const LIST_MIN_WIDTH = 280;
/** Below this the list leaves its column for a dropdown, so the preview keeps the width. */
const NARROW_BOARD_WIDTH = 960;
const LIST_MAX_FRACTION = 0.6;

const openIntegrationsSettings = () => {
    const ui = useUIStore.getState();
    ui.setSettingsPage('integrations');
    ui.setSettingsDialogOpen(true);
};

/** Linear's teams and which project each one works in, read once per open and workspace. */
function useLinearMapping(enabled: boolean, workspaceId: string): LinearMappingResult | null {
    const { linear } = useRuntimeAPIs();
    const [loaded, setLoaded] = React.useState<{ workspaceId: string; mapping: LinearMappingResult } | null>(null);
    React.useEffect(() => {
        if (!enabled || !linear?.mappingGet) return;
        let cancelled = false;
        void linear.mappingGet()
            .then((mapping) => { if (!cancelled) setLoaded({ workspaceId, mapping }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [enabled, linear, workspaceId]);
    return loaded && loaded.workspaceId === workspaceId ? loaded.mapping : null;
}

export const SourceBoardView: React.FC = () => {
    const open = useUIStore((state) => state.isSourceBoardOpen);
    if (!open) return null;
    return (
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
            <SourceBoard layout="desktop" />
        </div>
    );
};

/**
 * The board as the phone shell's page: one column, the preview in place of
 * the list, and `onLeave` once a session starts so the chat comes back.
 */
export const MobileSourceBoard: React.FC<{ onLeave: () => void }> = ({ onLeave }) => (
    <div className="flex h-full min-h-0 flex-col">
        <SourceBoard layout="mobile" onLeave={onLeave} />
    </div>
);

type SourceBoardLayout = 'desktop' | 'mobile';

/** What the board lists: the repository's issues or change requests, or Linear. */
type SourceBoardKind = GitHubReferenceKind | 'linear';

const SourceBoard: React.FC<{ layout: SourceBoardLayout; onLeave?: () => void }> = ({ layout, onLeave }) => {
    const { t } = useI18n();
    const { linear } = useRuntimeAPIs();
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const choice = useSourceBoardChoice();
    const updateChoice = useSourceBoardStore((state) => state.update);
    // The repository tab to land on when switching back from Linear.
    const [repositoryKind, setRepositoryKind] = React.useState<GitHubReferenceKind | undefined>(undefined);

    // The remembered project while it still exists, else the app's own.
    const project = projects.find((entry) => entry.id === choice.projectId)
        ?? projects.find((entry) => entry.id === activeProjectId)
        ?? projects[0]
        ?? null;
    const directory = project ? normalizeProjectPath(project.path) : null;
    const hostProvider = useRepositoryHostProvider(directory);
    const hasRepository = hostProvider === 'github' || hostProvider === 'gitlab';
    const hasLinear = Boolean(linear);
    const linearConnected = useLinearAuthStore((state) => state.status?.connected === true);
    const tab: SourceBoardTab | null = choice.tab === 'linear' && hasLinear
        ? 'linear'
        : hasRepository ? 'repository' : hasLinear ? 'linear' : null;

    const linearWorkspaceId = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const mapping = useLinearMapping(tab === 'linear' && linearConnected, linearWorkspaceId);
    const teams = mapping?.teams ?? [];
    const linearTeamId = choice.linearTeamId && teams.some((team) => team.id === choice.linearTeamId) ? choice.linearTeamId : null;

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
    // On Linear the board lists a team, not a project.
    const scopePicker = tab === 'linear' ? (
        <SourceBoardTeamPicker
            teams={teams}
            selectedTeamId={linearTeamId}
            onSelectTeam={(teamId) => updateChoice({ linearTeamId: teamId })}
            onWorkspaceSwitched={() => updateChoice({ linearTeamId: null })}
        />
    ) : projectPicker;

    const selectKind = (kind: SourceBoardKind) => {
        if (kind === 'linear') {
            updateChoice({ tab: 'linear' });
            return;
        }
        setRepositoryKind(kind);
        updateChoice({ tab: 'repository' });
    };

    if (!tab) {
        return (
            <>
                <div className="flex h-12 shrink-0 items-center border-b border-border/60 px-2">{projectPicker}</div>
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center typography-meta text-muted-foreground">
                    <span>{t(projects.length === 0 ? 'sourceBoard.empty.noProjects' : 'sourceBoard.empty.noSource')}</span>
                    {projects.length > 0 ? (
                        <Button size="sm" variant="outline" onClick={openIntegrationsSettings}>{t('references.picker.actions.openSettings')}</Button>
                    ) : null}
                </div>
            </>
        );
    }

    return (
        // Remounted per source and project: a new list starts with an empty search.
        <SourceBoardBody
            key={`${tab}:${tab === 'repository' ? directory : linearTeamId ?? ''}`}
            tab={tab}
            project={project}
            directory={directory}
            linearTeamId={linearTeamId}
            mapping={mapping}
            projects={projects}
            scopePicker={scopePicker}
            kinds={{ repository: hasRepository ? (hostProvider === 'gitlab' ? 'gitlab' : 'github') : null, linear: hasLinear }}
            initialRepositoryKind={repositoryKind}
            onSelectKind={selectKind}
            layout={layout}
            onLeave={onLeave}
        />
    );
};

const SourceBoardBody: React.FC<{
    tab: SourceBoardTab;
    project: ProjectEntry | null;
    directory: string | null;
    linearTeamId: string | null;
    mapping: LinearMappingResult | null;
    projects: ProjectEntry[];
    scopePicker: React.ReactNode;
    /** The tabs this project offers: its repository host's, and Linear's. */
    kinds: { repository: 'github' | 'gitlab' | null; linear: boolean };
    initialRepositoryKind?: GitHubReferenceKind;
    onSelectKind: (kind: SourceBoardKind) => void;
    layout: SourceBoardLayout;
    onLeave?: () => void;
}> = ({ tab, project, directory, linearTeamId, mapping, projects, scopePicker, kinds, initialRepositoryKind, onSelectKind, layout, onLeave }) => {
    const isMobile = layout === 'mobile';
    const { t } = useI18n();
    const source = tab === 'linear' ? 'linear' : 'github';
    // An item another surface asked to show: an issue or PR by its link, a
    // Linear issue by its identifier. It is read on its own, not typed into the
    // search: the list stays as it was, and the preview opens on the item.
    const [pinnedLink, setPinnedLink] = React.useState<{ kind: GitHubReferenceKind; url: string } | null>(null);
    const [pinnedLinearId, setPinnedLinearId] = React.useState<string | null>(null);
    const pinnedLookup = useGitHubReferenceList({
        enabled: tab === 'repository' && pinnedLink !== null,
        directory,
        kind: pinnedLink?.kind ?? 'issue',
        filter: DEFAULT_REPOSITORY_FILTER,
        query: pinnedLink?.url ?? '',
    });
    const { detail: pinnedLinear } = useLinearIssueDetail(tab === 'linear' ? pinnedLinearId : null, true);
    const pinnedReference = tab === 'repository' && pinnedLink ? pinnedLookup.items[0] ?? null : null;
    const pinnedLinearIssue = tab === 'linear' && pinnedLinear.status === 'ready' ? pinnedLinear.value : null;
    const pinnedItem = React.useMemo<ReferencePickerItem | null>(() => {
        if (pinnedReference) return { source: 'github', reference: pinnedReference };
        if (pinnedLinearIssue) return { source: 'linear', issue: pinnedLinearIssue };
        return null;
    }, [pinnedLinearIssue, pinnedReference]);
    const browser = useReferenceBrowser({
        source,
        directory: tab === 'linear' ? null : directory,
        isMobile,
        linearTeamId,
        initialGitHubKind: initialRepositoryKind,
        pinnedItem,
    });
    const { previewItem, setQuery, selectGitHubKind, showItem } = browser;
    const shownPinnedKeyRef = React.useRef<string | null>(null);
    const linearFocus = useSourceBoardStore((state) => (tab === 'linear' ? state.linearFocus : null));
    React.useEffect(() => {
        if (!linearFocus) return;
        shownPinnedKeyRef.current = null;
        setQuery('');
        setPinnedLinearId(linearFocus);
        useSourceBoardStore.getState().clearLinearFocus();
    }, [linearFocus, setQuery]);
    const repositoryFocus = useSourceBoardStore((state) => (tab === 'repository' ? state.repositoryFocus : null));
    React.useEffect(() => {
        if (!repositoryFocus) return;
        shownPinnedKeyRef.current = null;
        selectGitHubKind(repositoryFocus.kind);
        setQuery('');
        setPinnedLink({ kind: repositoryFocus.kind, url: repositoryFocus.query });
        useSourceBoardStore.getState().clearRepositoryFocus();
    }, [repositoryFocus, selectGitHubKind, setQuery]);
    // Shown once found; the user then moves on from it like from any row.
    React.useEffect(() => {
        if (!pinnedItem) return;
        const key = referencePickerItemKey(pinnedItem);
        if (shownPinnedKeyRef.current === key) return;
        shownPinnedKeyRef.current = key;
        showItem(key);
    }, [pinnedItem, showItem]);
    // Not found: a link the project's host does not know opens in the browser;
    // a Linear identifier is searched for instead.
    const pinnedLinkStatus = pinnedLookup.status;
    React.useEffect(() => {
        if (!pinnedLink || pinnedLinkStatus === 'loading' || pinnedReference) return;
        void openExternalUrl(pinnedLink.url);
        setPinnedLink(null);
    }, [pinnedLink, pinnedLinkStatus, pinnedReference]);
    const pinnedLinearStatus = pinnedLinear.status;
    React.useEffect(() => {
        if (!pinnedLinearId || pinnedLinearStatus !== 'error') return;
        setQuery(pinnedLinearId);
        setPinnedLinearId(null);
    }, [pinnedLinearId, pinnedLinearStatus, setQuery]);
    const currentDirectory = useEffectiveDirectory();
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const [worktreeRequest, setWorktreeRequest] = React.useState<{ project: SourceBoardProject; selection: ReferencePickerSelection } | null>(null);

    // A Linear issue starts in its team's project, else the mapping's default,
    // else the project the board was last on; the user can pick another.
    const [linearProjectChoice, setLinearProjectChoice] = React.useState<{ issueId: string; projectId: string } | null>(null);
    const linearIssueId = previewItem?.source === 'linear' ? previewItem.issue.id : null;
    const linearProjectOverride = linearProjectChoice && linearProjectChoice.issueId === linearIssueId ? linearProjectChoice.projectId : null;
    const linearTeam = previewItem?.source === 'linear' ? previewItem.issue.team ?? null : null;
    const mappedPath = previewItem?.source === 'linear' ? resolveLinearMappedProjectPath(mapping, linearTeam) : null;
    const mappedProject = mappedPath ? projects.find((entry) => normalizeProjectPath(entry.path) === normalizeProjectPath(mappedPath)) ?? null : null;
    const actionProjectEntry = tab === 'linear'
        ? projects.find((entry) => entry.id === linearProjectOverride) ?? mappedProject ?? project
        : project;
    const actionPath = actionProjectEntry ? normalizeProjectPath(actionProjectEntry.path) : null;
    const actionProject: SourceBoardProject | null = actionProjectEntry && actionPath ? { id: actionProjectEntry.id, path: actionPath } : null;
    const actionContext = useGitHubReadContext(actionProject?.path ?? null);
    const context: SourceControlReadContext | null = actionContext && actionContext !== 'missing' ? actionContext : null;

    const projectOwnsDirectory = React.useCallback((candidate: string | undefined) => {
        if (!candidate || !actionProjectEntry) return false;
        return resolveProjectForSessionDirectory(projects, worktreesByProject, candidate)?.id === actionProjectEntry.id;
    }, [actionProjectEntry, projects, worktreesByProject]);

    const title = t(tab === 'linear' ? 'sourceBoard.list.linear' : browser.isGitLab ? 'sourceBoard.list.gitlab' : 'sourceBoard.list.github');

    // Where a Linear issue's session starts, changeable for that issue.
    const startIn = tab === 'linear' && actionProjectEntry ? (
        <span className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
            {t('sourceBoard.linear.startIn')}
            <SourceBoardProjectPicker
                projects={projects}
                selected={actionProjectEntry}
                onSelect={(projectId) => { if (linearIssueId) setLinearProjectChoice({ issueId: linearIssueId, projectId }); }}
                ariaLabel={t('sourceBoard.linear.startIn')}
                size="inline"
                sheet={isMobile}
            />
        </span>
    ) : null;

    const actions = previewItem ? (
        <SourceBoardActions
            item={previewItem}
            project={actionProject}
            context={context}
            onStartWorktree={(target, selection) => setWorktreeRequest({ project: target, selection })}
            onChanged={browser.list.retry}
            startIn={startIn}
            onLeave={onLeave}
        />
    ) : null;

    const attachments = usePullAttachments(previewItem?.source === 'github' ? previewItem.reference : null);

    // The previewed PR's check runs, opened from its checks totals.
    const [checksOpenFor, setChecksOpenFor] = React.useState<string | null>(null);
    const previewPull = previewItem?.source === 'github' && previewItem.reference.kind === 'pull' ? previewItem.reference : null;
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

    // After a change to an issue or PR: its detail and the list read again.
    const refreshRepositoryItem = () => {
        browser.refreshGithubDetail();
        browser.list.retry();
    };

    const preview = (
        <ReferencePreview
            item={previewItem}
            pullStatus={previewItem?.source === 'github' ? browser.pullStatusOf(previewItem.reference) : IDLE_PULL_STATUS}
            linearDetail={browser.linearDetail}
            githubDetail={browser.githubDetail}
            purpose="attach"
            pinned={!isMobile}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={browser.now}
            footer={actions}
            linearStateControl={previewItem?.source === 'linear' ? <SourceBoardLinearStatus issue={previewItem.issue} onChanged={browser.list.retry} /> : undefined}
            onOpenLinearIssue={(issue) => browser.openItem({ source: 'linear', issue })}
            onOpenChecks={previewPull && context ? () => setChecksOpenFor(previewKey) : undefined}
            stateMenu={previewItem?.source === 'github' && previewItem.reference.state !== 'merged' && context ? (
                <SourceBoardStateMenuItems item={previewItem} context={context} onChanged={refreshRepositoryItem} />
            ) : undefined}
            commentAttachments={previewItem?.source === 'github'
                ? { onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }
                : undefined}
            labelsControl={previewItem?.source === 'github' && context ? (
                <SourceBoardLabels key={referencePickerItemKey(previewItem)} reference={previewItem.reference} context={context} onChanged={refreshRepositoryItem} />
            ) : undefined}
            reviewersControl={previewItem?.source === 'github' && previewItem.reference.kind === 'pull' && context ? (
                <SourceBoardReviewers
                    key={referencePickerItemKey(previewItem)}
                    pull={previewItem.reference}
                    detail={browser.githubDetail}
                    context={context}
                    onChanged={refreshRepositoryItem}
                />
            ) : undefined}
            // Keyed by the item: a draft never carries over to another one.
            reply={previewItem?.source === 'github' && context ? (
                <SourceBoardReply
                    key={referencePickerItemKey(previewItem)}
                    reference={previewItem.reference}
                    context={context}
                    onRefresh={refreshRepositoryItem}
                />
            ) : undefined}
            // The phone shell has no side panel to open a PR's changes in.
            pullLinks={!isMobile && previewItem?.source === 'github' && previewItem.reference.kind === 'pull' && actionProject && context ? (
                <SourceBoardPullLinks
                    pull={previewItem.reference}
                    project={actionProject}
                    context={context}
                    projectOwnsDirectory={projectOwnsDirectory}
                    currentDirectory={currentDirectory}
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
        />
    );
    const search = (
        <ReferenceBrowserSearch
            browser={browser}
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
        ? previewItem.source === 'linear' ? previewItem.issue.identifier : referenceNumberLabel(previewItem.reference)
        : t('sourceBoard.list.choose');
    const itemIcon = previewItem?.source === 'linear' || tab === 'linear'
        ? 'linear'
        : browser.githubKind === 'pull' ? 'git-pull-request' : 'record-circle';
    const itemTrigger = (
        <button
            type="button"
            className={cn(dropdownTriggerVariants({ size: 'default' }), 'shrink-0 gap-1.5')}
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
            onWorktreeCreated={(worktreePath) => {
                useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: worktreePath, preserveDirectoryOverride: true });
                onLeave?.();
            }}
        />
    );

    const kindItems = [
        ...(kinds.repository ? [
            { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
            { id: 'pull', label: t(kinds.repository === 'gitlab' ? 'references.picker.tab.mergeRequests' : 'references.picker.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
        ] : []),
        ...(kinds.linear ? [{ id: 'linear', label: 'Linear', icon: <Icon name="linear" className="size-3.5" /> }] : []),
    ];
    const kindSwitch = (
        <div className={isMobile ? 'w-full' : 'shrink-0'}>
            <SortableTabsStrip
                items={kindItems}
                activeId={tab === 'linear' ? 'linear' : browser.githubKind}
                onSelect={(id) => {
                    if (id === 'linear' || tab === 'linear') {
                        onSelectKind(id === 'pull' ? 'pull' : id === 'issue' ? 'issue' : 'linear');
                        return;
                    }
                    browser.selectGitHubKind(id === 'pull' ? 'pull' : 'issue');
                }}
                variant="active-pill"
                // Desktop: sized by its labels in a row that gives it no width of its
                // own. Phone: the full row, shared.
                layoutMode={isMobile ? 'fit' : 'scrollable'}
                intrinsicWidth={!isMobile}
                // A narrow board names the kinds by icon; the label is the tooltip.
                iconOnly={narrow}
                activePillButtonClassName={isMobile ? undefined : narrow ? 'h-7 px-2.5' : 'h-7 px-3'}
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
        setResizing(true);
        const onMove = (move: PointerEvent) => useSourceBoardStore.getState().setListWidth(clampWidth(startWidth + move.clientX - startX));
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
        const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        if (delta === 0) return;
        event.preventDefault();
        useSourceBoardStore.getState().setListWidth(clampWidth((listRef.current?.offsetWidth ?? LIST_MIN_WIDTH) + delta));
    };

    if (isMobile) {
        const inPreview = Boolean(browser.mobilePreviewKey && previewItem);
        return (
            <>
                {inPreview ? (
                    <div className="flex shrink-0 items-center border-b border-border/60 px-2 py-1.5">
                        <Button variant="ghost" size="sm" onClick={browser.closeMobilePreview}>
                            <Icon name="arrow-left-s" className="size-4" />
                            {t('references.picker.actions.back')}
                        </Button>
                    </div>
                ) : (
                    <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
                        <div className="-ml-1.5 flex min-w-0">{scopePicker}</div>
                        {kindSwitch}
                        {search}
                    </div>
                )}
                <ScrollableOverlay outerClassName="min-h-0 flex-1" className={inPreview ? 'px-4 py-3' : undefined} disableHorizontal>
                    {inPreview ? preview : list}
                </ScrollableOverlay>
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
                        "before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']",
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
