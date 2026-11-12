import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { formatSessionDateLabel, normalizePath } from '@/components/session/sidebar/utils';
import { useShallow } from 'zustand/react/shallow';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { requestReasoningReveal } from '@/components/chat/search/reasoningReveal';
import { refreshSpaceArchives, useSpaceArchivesStore } from '@/lib/spaces/space-archives';
import { isRestorableOnItsOwn } from '@/sync/session-restore-rule';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessions/sessionOwnership';
import { formatProjectLabel } from '@/components/session/sidebar/utils';
import { resolveSidebarSessionLocations, type SidebarSessionLocation } from '@/components/session/sidebar/recent/sessionLocation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitAllBranches } from '@/stores/useGitStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { useSidebarSpaces } from '@/lib/spaces/spaces-store';
import { loadWorktreeArchives, useWorktreeArchivesByProject } from '@/lib/worktrees/worktreeArchive';
import { ArchivedWorktreeRow } from './archive/ArchivedWorktreeRow';
import { useWorktreeArchiveActions } from './archive/useWorktreeArchiveActions';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useConversationSearch, type ConversationResult } from '@/hooks/useConversationSearch';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import { matchesConversationProjectScope, matchesConversationWorktreeScope } from '@/lib/search/conversationScope';
import { ConversationResultRow } from '@/components/search/ConversationResultRow';
import { conversationContextFromLocation, type ConversationResultContext, type ConversationResultProject } from '@/components/search/conversationResultContext';
import type { SearchMetaItem } from '@/components/search/SearchMetaList';
import { SearchFilterSelect } from '@/components/search/SearchFilterSelect';
import { SearchScopeMenu } from '@/components/search/SearchScopeMenu';
import { SearchStatusLine } from '@/components/search/SearchStatusLine';
import { SearchFilterChips } from '@/components/search/SearchFilterChips';
import { searchFilterChipKeys } from '@/components/search/searchFilterChipKeys';
import { parseOmniQuery, type OmniFilters } from '@/lib/search/omniQuery';
import { useOmniSearchState } from '@/lib/search/omniSearchState';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { splitSnippet } from '@/lib/messageSearch';

/**
 * A group in the panel on the left: a project with its worktrees (archived
 * ones included), the chats of a deleted isolated space (named after the
 * space, with no way to restore them), or everything else.
 */
type ArchiveBucket = {
  key: string;
  kind: 'project' | 'space' | 'other';
  label: string;
  /** The project's root or the space's directory; empty for everything else. */
  directory: string;
  /** The project's id, for a project bucket. */
  projectId?: string;
  sessions: Session[];
};

const OTHER_BUCKET_KEY = '\u0000other';

// Bound the mounted DOM: archives grow into the hundreds; batch rendering
// keeps the list responsive without a virtualizer.
const PAGE_SIZE = 100;

const NO_SEARCH_LOCATIONS: ReadonlyMap<string, SidebarSessionLocation> = new Map();

type SearchResultRowsProps = {
  result: ConversationResult;
  query: string;
  context: ConversationResultContext;
  mobile: boolean;
  onOpen: () => void;
  onOpenExcerpt: (messageId: string) => void;
  onRestore: () => void;
  restoreLabel: string;
  restorable: boolean;
  lifecycle: 'active' | 'archived' | 'all';
  author: OmniFilters['author'];
  includeReasoning: boolean;
  contentAvailable: boolean;
};

function ArchiveSearchResultRow({ result, query, context, mobile, onOpen, onOpenExcerpt, onRestore, restoreLabel, restorable, lifecycle, author, includeReasoning, contentAvailable }: SearchResultRowsProps): React.ReactNode {
  const { t } = useI18n();
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const role = author === 'user' ? 'user' : author === 'assistant' ? 'assistant' : author === 'reasoning' ? 'reasoning' : null;
  const expansionKey = `${query}\0${lifecycle}\0${author}\0${includeReasoning}\0${contentAvailable}`;
  const showMatches = expandedKey === expansionKey;
  const matches = useMessageSearch({ query, enabled: showMatches && contentAvailable, limit: PAGE_SIZE, sessionId: result.sessionId, lifecycle, role, includeReasoning });
  const openHit = (messageId: string, hitRole: string): void => {
    requestReasoningReveal(hitRole === 'reasoning' ? messageId : null);
    onOpenExcerpt(messageId);
  };
  return <div data-archive-search-result={result.sessionId}>
    <ConversationResultRow
      result={result}
      context={context}
      mobile={mobile}
      onOpen={onOpen}
      onOpenExcerpt={() => {
        if (result.excerpt) openHit(result.excerpt.messageId, result.excerpt.role);
      }}
      onShowMoreMatches={result.moreMatches > 0 && contentAvailable ? () => setExpandedKey(expansionKey) : undefined}
      trailing={restorable ? <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size={mobile ? 'lg' : 'xs'} className={mobile ? 'min-h-11 min-w-11' : undefined} onClick={onRestore} aria-label={restoreLabel}><Icon name="inbox-unarchive" className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{restoreLabel}</TooltipContent></Tooltip> : null}
    />
    {showMatches ? <div className="ms-3 space-y-0.5" data-archive-other-matches={result.sessionId} aria-live="polite">
      {'hits' in matches.state ? matches.state.hits.filter((hit) => hit.id !== result.excerpt?.messageId).map((hit) => <button key={hit.id} type="button" className="block w-full truncate text-start typography-micro text-muted-foreground hover:text-foreground" onClick={() => openHit(hit.id, hit.role)}><MatchHighlight segments={splitSnippet(hit.snippet)} /></button>) : null}
      {matches.state.status === 'loading' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.searching')}</span> : null}
      {matches.state.status === 'error' || (matches.state.status === 'ready' && matches.state.pageError) ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.error')}</span> : null}
      {matches.state.status === 'unavailable' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.unsupported')}</span> : null}
      {matches.state.status === 'too-short' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.tooShort')}</span> : null}
      {matches.state.status === 'ready' && matches.state.next ? <button type="button" className="typography-micro text-muted-foreground hover:text-foreground hover:underline" onClick={matches.loadMore} disabled={matches.state.loadingMore}>{t('search.omni.result.loadMore')}</button> : null}
    </div> : null}
  </div>;
}

// Subsessions of one parent sit together, at the place of the first of them.
const groupByParent = (sessions: Session[]): Session[] => {
  const byParent = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const siblings = byParent.get(session.parentID);
    if (siblings) siblings.push(session);
    else byParent.set(session.parentID, [session]);
  }
  const grouped: Session[] = [];
  const placedParents = new Set<string>();
  for (const session of sessions) {
    if (!session.parentID) {
      grouped.push(session);
      continue;
    }
    if (placedParents.has(session.parentID)) continue;
    placedParents.add(session.parentID);
    grouped.push(...(byParent.get(session.parentID) ?? []));
  }
  return grouped;
};

/**
 * The archive itself, mounted only while it is on screen, so every open starts
 * fresh. `page` is the desktop surface that replaces the chat area; `mobile`
 * is the single-column list inside the phone's fullscreen surface. `onLeave`
 * runs once an archived session has been opened. `initialQuery` fills the
 * search field, for a sidebar search that found nothing.
 */
export function ArchiveSessionsView({ layout, onLeave, initialQuery = '' }: {
  layout: 'page' | 'mobile';
  onLeave: () => void;
  initialQuery?: string;
}): React.ReactNode {
  const { t } = useI18n();
  const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
  const messageSearchReasoningEnabled = useUIStore((state) => state.messageSearchReasoningEnabled);
  const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const gitBranches = useGitAllBranches(true);
  const spaceList = useSidebarSpaces();
  // Narrow selections: the cache's entity map changes with every active
  // session update, and the page only depends on which archived sessions are
  // listed and on their parents' titles.
  const listedSessions = useGlobalSessionsStore(useShallow((state) => state.archivedSessions
    .filter((session) => isRestorableOnItsOwn(session, state.entityById))));
  const activeSessions = useGlobalSessionsStore(useShallow((state) => state.activeSessions
    .filter((session) => isRestorableOnItsOwn(session, state.entityById))));
  const parentTitlePairs = useGlobalSessionsStore(useShallow((state) => state.archivedSessions.flatMap((session) => {
    const parent = session.parentID ? state.entityById.get(session.parentID) : undefined;
    return parent ? [parent.id, parent.title] : [];
  })));
  const sessionsStatus = useGlobalSessionsStore((state) => state.status);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  const spaceArchives = useSpaceArchivesStore((state) => state.byDirectory);
  const searchProjects = React.useMemo(() => projects.flatMap((project) => {
    const value = normalizePath(project.path);
    return value ? [{ value, label: formatProjectLabel(project.label?.trim() || project.path.split('/').filter(Boolean).pop() || project.path) }] : [];
  }), [projects]);
  const { text, filters, query, setText, setFilter: setSearchFilter, removeFilter, clearAll } = useOmniSearchState({
    surface: 'archive',
    defaults: { lifecycle: 'archived', searchIn: 'everything', author: 'any' },
    projects: searchProjects,
  });

  React.useEffect(() => {
    if (initialQuery) setText(initialQuery);
  }, [initialQuery, setText]);

  // The chats of deleted spaces are read-only and named after their space; read which they are
  // each time the page opens, since a space may have been deleted from another window.
  React.useEffect(() => {
    void refreshSpaceArchives().catch(() => {});
  }, []);

  const labelOf = React.useCallback((directory: string): string => {
    const archive = spaceArchives?.get(directory);
    if (archive) return archive.name;
    return directory ? (formatDirectoryName(directory, homeDirectory) || directory) : t('sessions.archivePage.otherProjects');
  }, [homeDirectory, spaceArchives, t]);

  const parsedQuery = React.useMemo(() => parseOmniQuery(query), [query]);
  const normalizedQuery = parsedQuery.text.trim().toLowerCase();
  const hasSearchQuery = Boolean(query.trim());
  const lifecycle = filters.lifecycle ?? 'archived';
  const searchIn = filters.searchIn ?? 'everything';
  const author = filters.author ?? 'any';
  const effectiveAuthor = author === 'reasoning' && !(messageSearchReasoningEnabled && showReasoningTraces) ? 'any' : author;

  const openCodeProjects = useGlobalSyncStore((state) => state.projects);

  // Sessions belong to their project the way the sidebar groups them: by
  // folder, then by OpenCode's project, which is what still places a session
  // of a worktree that is gone.
  const ownershipCandidates = React.useMemo(() => [...listedSessions, ...activeSessions], [activeSessions, listedSessions]);
  const ownershipProjects = React.useMemo(() => projects.flatMap((project) => {
    const normalizedPath = normalizePath(project.path);
    return normalizedPath ? [{ id: project.id, normalizedPath }] : [];
  }), [projects]);
  const ownership = React.useMemo(() => createSessionOwnershipIndex(
    ownershipCandidates,
    ownershipProjects,
    worktreesByProject,
    false,
    [],
    openCodeProjects,
  ), [openCodeProjects, ownershipCandidates, ownershipProjects, worktreesByProject]);
  // Isolated spaces name the sessions that live in them. Only search results need that index, so browsing does not build it.
  const searchOwnership = React.useMemo(() => (hasSearchQuery ? createSessionOwnershipIndex(
    ownershipCandidates,
    ownershipProjects,
    worktreesByProject,
    false,
    [],
    openCodeProjects,
    spaceList,
  ) : null), [hasSearchQuery, openCodeProjects, ownershipCandidates, ownershipProjects, spaceList, worktreesByProject]);
  const spaceLabelById = React.useMemo(() => new Map(spaceList.map((space) => [space.id, space.name])), [spaceList]);
  const locationProjects = React.useMemo(() => projects.flatMap((project) => {
    const normalizedPath = normalizePath(project.path);
    if (!normalizedPath) return [];
    return [{
      id: project.id,
      label: formatProjectLabel(project.label?.trim() || formatDirectoryName(normalizedPath, homeDirectory) || normalizedPath),
      normalizedPath,
    }];
  }), [homeDirectory, projects]);
  const projectById = React.useMemo(() => new Map(projects.map((project): [string, ConversationResultProject] => [project.id, {
    id: project.id,
    label: formatProjectLabel(project.label?.trim() || formatDirectoryName(project.path, homeDirectory) || project.path),
    icon: project.icon,
    color: project.color,
    iconImage: project.iconImage,
    iconBackground: project.iconBackground,
  }])), [homeDirectory, projects]);
  const searchLocationBySessionId = React.useMemo(() => (searchOwnership ? resolveSidebarSessionLocations({
    sessions: ownershipCandidates,
    projects: locationProjects,
    ownerBySessionId: searchOwnership.bySessionId,
    spaceLabelById,
    availableWorktreesByProject: worktreesByProject,
    gitBranches,
    homeDirectory,
    hideBranchMatchingProjectLabel: false,
  }) : NO_SEARCH_LOCATIONS), [gitBranches, homeDirectory, locationProjects, ownershipCandidates, searchOwnership, spaceLabelById, worktreesByProject]);
  const locationProjectById = React.useMemo(() => new Map(locationProjects.map((project) => [project.id, project])), [locationProjects]);

  // A worktree that is gone matches no project by folder, so its sessions are
  // listed once the server confirms the folder is missing. A folder that still
  // exists stays behind admission, whatever project OpenCode files it under.
  const unadmittedOwnedDirectories = React.useMemo(() => [...new Set(ownershipCandidates.flatMap((session) => {
    const directory = resolveGlobalSessionDirectory(session);
    return directory && ownership.bySessionId.has(session.id) && !isSessionDirectoryAdmitted(directory, projects, worktreesByProject) ? [directory] : [];
  }))].sort().join('\n'), [ownership, ownershipCandidates, projects, worktreesByProject]);
  const [goneDirectories, setGoneDirectories] = React.useState<ReadonlySet<string>>(() => new Set());
  React.useEffect(() => {
    if (!unadmittedOwnedDirectories) return undefined;
    let current = true;
    void Promise.all(unadmittedOwnedDirectories.split('\n').map(async (directory) => (
      await opencodeClient.getDirectoryAvailability(directory) === 'missing' ? [directory] : []
    ))).then((gone) => {
      if (current) setGoneDirectories(new Set(gone.flat()));
    });
    return () => { current = false; };
  }, [unadmittedOwnedDirectories]);

  // A subsession under an archived parent comes back with that parent and is
  // not listed. One archived while its parent stays active would otherwise
  // show nowhere, so it is listed under its parent's title and restored alone.
  const sortedSessions = React.useMemo(
    () => listedSessions.filter((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      return isSessionDirectoryAdmitted(directory, projects, worktreesByProject)
        || Boolean(directory && spaceArchives?.has(directory))
        || Boolean(directory && goneDirectories.has(directory) && ownership.bySessionId.has(session.id));
    }).sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0)),
    [goneDirectories, listedSessions, ownership, projects, spaceArchives, worktreesByProject],
  );

  const parentTitles = React.useMemo(() => {
    const titles = new Map<string, string>();
    for (let index = 0; index < parentTitlePairs.length; index += 2) titles.set(parentTitlePairs[index], parentTitlePairs[index + 1]);
    return titles;
  }, [parentTitlePairs]);

  // The parent's title, shown once above the first of its subsessions' rows.
  const parentTitleAbove = (rows: Session[], index: number): string | null => {
    const parentID = rows[index]?.parentID;
    if (!parentID || rows[index - 1]?.parentID === parentID) return null;
    return parentTitles.get(parentID) || t('sessions.sidebar.session.untitled');
  };

  const archivesByProject = useWorktreeArchivesByProject();
  const archiveActions = useWorktreeArchiveActions();

  // Archived worktrees live in each project's repository; read them each time
  // the page opens, like the spaces above.
  React.useEffect(() => {
    for (const project of projects) void loadWorktreeArchives(project.path).catch(() => undefined);
  }, [projects]);

  const buckets = React.useMemo<ArchiveBucket[]>(() => {
    const byKey = new Map<string, ArchiveBucket>();
    const bucketFor = (key: string, create: () => Omit<ArchiveBucket, 'sessions'>): ArchiveBucket => {
      const existing = byKey.get(key);
      if (existing) return existing;
      const bucket = { ...create(), sessions: [] };
      byKey.set(key, bucket);
      return bucket;
    };
    const projectBucket = (root: string) => {
      const project = projects.find((entry) => normalizePath(entry.path) === root);
      return bucketFor(root, () => ({
        key: root,
        kind: 'project',
        label: formatProjectLabel(project?.label?.trim() || root.split('/').filter(Boolean).pop() || root),
        directory: root,
        projectId: project?.id,
      }));
    };
    for (const session of sortedSessions) {
      const directory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
      if (directory && spaceArchives?.has(directory)) {
        bucketFor(directory, () => ({ key: directory, kind: 'space', label: labelOf(directory), directory })).sessions.push(session);
        continue;
      }
      const projectRoot = normalizePath(ownership.bySessionId.get(session.id)?.projectRoot ?? null);
      if (projectRoot) {
        projectBucket(projectRoot).sessions.push(session);
        continue;
      }
      bucketFor(OTHER_BUCKET_KEY, () => ({ key: OTHER_BUCKET_KEY, kind: 'other', label: t('sessions.archivePage.other'), directory: '' })).sessions.push(session);
    }
    // A project whose only archive is a worktree without sessions is listed too.
    for (const [root, entry] of archivesByProject) {
      if (entry.archives.length > 0) projectBucket(root);
    }
    const order = { project: 0, space: 1, other: 2 } as const;
    return [...byKey.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  }, [archivesByProject, labelOf, ownership, projects, sortedSessions, spaceArchives, t]);

  const projectLabelFor = React.useCallback((session: Session, directory: string | null): string | null => {
    if (directory && spaceArchives?.has(directory)) return labelOf(directory);
    const owner = ownership.bySessionId.get(session.id);
    if (!owner) return null;
    const project = projects.find((entry) => entry.id === owner.projectId);
    return formatProjectLabel(project?.label?.trim() || owner.projectRoot.split('/').filter(Boolean).pop() || owner.projectRoot);
  }, [labelOf, ownership, projects, spaceArchives]);
  const topologyWorktrees = React.useMemo(() => [...worktreesByProject.entries()].flatMap(([projectRoot, worktrees]) => worktrees.map((worktree) => ({ ...worktree, projectRoot: normalizePath(projectRoot) }))), [worktreesByProject]);
  const topologyDirectories = React.useMemo(() => [...new Set([
    ...projects.map((project) => normalizePath(project.path)),
    ...topologyWorktrees.map((worktree) => normalizePath(worktree.path)),
  ].filter((directory): directory is string => Boolean(directory)))], [projects, topologyWorktrees]);
  const matchesProjectScope = React.useCallback((value: string, root: string, projectId?: string): boolean => {
    const project = projects.find((entry) => entry.id === projectId || normalizePath(entry.path) === root);
    return matchesConversationProjectScope(value, root, project?.label);
  }, [projects]);
  const projectMatches = React.useCallback((session: Session, value: string): boolean => {
    const owner = ownership.bySessionId.get(session.id);
    if (value === '__other__') return !owner;
    if (!owner) return false;
    return matchesProjectScope(value, owner.projectRoot, owner.projectId);
  }, [matchesProjectScope, ownership]);
  const worktreeMatches = React.useCallback((directory: string | null, value: string): boolean => topologyWorktrees.some((worktree) => (
    Boolean(directory) && normalizePath(worktree.path) === directory && matchesConversationWorktreeScope(value, worktree)
  )), [topologyWorktrees]);
  const worktreeLabelFor = React.useCallback((session: Session): string | null => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    const worktree = topologyWorktrees.find((entry) => normalizePath(entry.path) === directory);
    if (worktree) return [worktree.label, worktree.branch, worktree.path].filter(Boolean).join(' ');
    const owner = ownership.bySessionId.get(session.id);
    if (!owner || owner.kind !== 'worktree') return null;
    return owner.scopeDirectory.split('/').filter(Boolean).pop() || owner.scopeDirectory;
  }, [ownership, topologyWorktrees]);
  const searchedSessions = React.useMemo(() => {
    const candidates = lifecycle === 'active' ? activeSessions : lifecycle === 'all' ? [...listedSessions, ...activeSessions] : listedSessions;
    return candidates.filter((session) => {
      const directory = normalizePath(resolveGlobalSessionDirectory(session));
      const admitted = isSessionDirectoryAdmitted(directory, projects, worktreesByProject)
        || Boolean(directory && spaceArchives?.has(directory))
        || Boolean(directory && goneDirectories.has(directory) && ownership.bySessionId.has(session.id));
      if (!admitted) return false;
      if (filters.project) {
        if (!projectMatches(session, filters.project)) return false;
      }
      if (filters.worktree && !worktreeMatches(directory, filters.worktree)) return false;
      return true;
    });
  }, [activeSessions, filters.project, filters.worktree, goneDirectories, lifecycle, listedSessions, ownership, projectMatches, projects, spaceArchives, worktreeMatches, worktreesByProject]);
  const searchedSessionById = React.useMemo(() => new Map(searchedSessions.map((session) => [session.id, session])), [searchedSessions]);
  const archiveSearchResultContext = React.useCallback(({
    result,
    mobile,
  }: {
    result: ConversationResult;
    mobile: boolean;
  }): ConversationResultContext => {
    const session = searchedSessionById.get(result.sessionId);
    const directory = normalizePath(result.directory ?? session?.directory ?? null);
    const location = searchLocationBySessionId.get(result.sessionId);
    const spaceArchive = directory ? spaceArchives?.get(directory) : undefined;
    const projectId = location?.projectId ?? null;
    const extras: SearchMetaItem[] = [];
    const parentTitle = session?.parentID ? parentTitles.get(session.parentID) : null;
    if (parentTitle) extras.push({ key: 'parent', text: parentTitle, dir: 'auto', priority: 'yield' });
    if (!mobile) extras.push({
      key: 'date',
      text: formatSessionDateLabel(session?.time?.archived ?? session?.time?.updated ?? Date.now()),
      dir: 'auto',
      priority: 'keep',
    });
    return conversationContextFromLocation({
      location,
      directory,
      project: spaceArchive || !projectId ? null : projectById.get(projectId) ?? null,
      projectRoot: projectId ? locationProjectById.get(projectId)?.normalizedPath ?? null : null,
      homeDirectory,
      folderOverride: spaceArchive?.name ?? null,
      extras,
    });
  }, [homeDirectory, locationProjectById, parentTitles, projectById, searchLocationBySessionId, searchedSessionById, spaceArchives]);
  const selectedDirectories = React.useMemo(() => {
    if (hasSearchQuery) {
      if (!filters.project && !filters.worktree) return [...new Set([
        ...topologyDirectories,
        ...searchedSessions.map((session) => normalizePath(resolveGlobalSessionDirectory(session))).filter((directory): directory is string => Boolean(directory)),
      ])];
      const directories = new Set<string>();
      const selectedProjectRoots = new Set(projects.flatMap((project) => {
        const root = normalizePath(project.path);
        return root && (!filters.project || (filters.project !== '__other__' && matchesProjectScope(filters.project, root, project.id))) ? [root] : [];
      }));
      for (const project of projects) {
        const root = normalizePath(project.path);
        if (!filters.worktree && root && selectedProjectRoots.has(root)) directories.add(root);
      }
      for (const worktree of topologyWorktrees) {
        const directory = normalizePath(worktree.path);
        if (directory && (!filters.project || selectedProjectRoots.has(worktree.projectRoot ?? '')) && (!filters.worktree || worktreeMatches(directory, filters.worktree))) directories.add(directory);
      }
      for (const session of ownershipCandidates) {
        const directory = normalizePath(resolveGlobalSessionDirectory(session));
        if (directory && (!filters.project || projectMatches(session, filters.project)) && (!filters.worktree || worktreeMatches(directory, filters.worktree))) directories.add(directory);
      }
      for (const session of searchedSessions) {
        const directory = normalizePath(resolveGlobalSessionDirectory(session));
        if (directory) directories.add(directory);
      }
      return [...directories];
    }
    return selectedKey === null ? undefined : buckets.find((bucket) => bucket.key === selectedKey)?.sessions.map(resolveGlobalSessionDirectory).filter((directory): directory is string => Boolean(directory));
  }, [buckets, filters.project, filters.worktree, hasSearchQuery, matchesProjectScope, ownershipCandidates, projectMatches, projects, searchedSessions, selectedKey, topologyDirectories, topologyWorktrees, worktreeMatches]);
  const metadataItems = React.useMemo(() => searchedSessions.map((session) => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    return { sessionId: session.id, title: session.title || t('sessions.sidebar.session.untitled'), projectLabel: projectLabelFor(session, directory), worktreeLabel: worktreeLabelFor(session), directory, archived: Boolean(session.time?.archived) };
  }), [projectLabelFor, searchedSessions, t, worktreeLabelFor]);
  const conversationSearch = useConversationSearch({
    enabled: hasSearchQuery, text: normalizedQuery, lifecycle, searchIn: hasSearchQuery && selectedDirectories?.length === 0 ? 'titles' : searchIn, author: effectiveAuthor, metadataItems, directories: selectedDirectories,
    isAdmitted: (directory) => (selectedDirectories === undefined || Boolean(directory && selectedDirectories.includes(directory))) && (isSessionDirectoryAdmitted(directory, projects, worktreesByProject) || Boolean(directory && spaceArchives?.has(directory)) || Boolean(directory && goneDirectories.has(directory))),
    pageSize: PAGE_SIZE,
  });

  const selectedBucket = selectedKey === null ? null : buckets.find((bucket) => bucket.key === selectedKey) ?? null;
  React.useEffect(() => {
    if (hasSearchQuery && !filters.project) setSelectedKey(null);
  }, [filters.project, hasSearchQuery]);
  const selectedProject = selectedBucket?.projectId ? { id: selectedBucket.projectId, path: selectedBucket.directory } : null;
  // The selected project's archived worktrees, each with its own sessions.
  const worktreeGroups = React.useMemo(() => {
    if (hasSearchQuery || selectedBucket?.kind !== 'project') return [];
    const listed = new Map(selectedBucket.sessions.map((session) => [session.id, session] as const));
    return (archivesByProject.get(selectedBucket.directory)?.archives ?? []).map((archive) => ({
      archive,
      sessions: groupByParent(archive.sessionIds.flatMap((id) => {
        const session = listed.get(id);
        return session ? [session] : [];
      }).sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0))),
    }));
  }, [archivesByProject, hasSearchQuery, selectedBucket]);
  const inWorktreeGroup = React.useMemo(
    () => new Set(worktreeGroups.flatMap((group) => group.sessions.map((session) => session.id))),
    [worktreeGroups],
  );

  // Search spans every archived session; the directory filter applies only
  // while not searching.
  const searchResults = React.useMemo<ConversationResult[]>(() => normalizedQuery ? conversationSearch.results : metadataItems.map((item) => ({
    sessionId: item.sessionId,
    title: item.title,
    titleRanges: [],
    directory: item.directory,
    archived: item.archived,
    metadata: null,
    excerpt: null,
    moreMatches: 0,
  })), [conversationSearch.results, metadataItems, normalizedQuery]);
  const filteredSessions = React.useMemo(() => {
    if (hasSearchQuery) {
      const byId = new Map(searchedSessions.map((session) => [session.id, session]));
      return searchResults.flatMap((result) => {
        const session = byId.get(result.sessionId);
        return session ? [session] : [];
      });
    }
    if (selectedBucket === null) return groupByParent(sortedSessions);
    return groupByParent(selectedBucket.sessions.filter((session) => !inWorktreeGroup.has(session.id)));
  }, [hasSearchQuery, inWorktreeGroup, searchResults, searchedSessions, selectedBucket, sortedSessions]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const remainingCount = (hasSearchQuery ? searchResults.length : filteredSessions.length) - visibleCount;
  const archiveCount = sortedSessions.length;
  const metadataCountsByDirectory = React.useMemo(() => metadataItems.reduce((counts, item) => {
    if (item.directory) counts.set(item.directory, (counts.get(item.directory) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()), [metadataItems]);
  const searchTotalCount = normalizedQuery ? conversationSearch.totalCount : metadataItems.length;
  const searchCountsByDirectory = normalizedQuery ? conversationSearch.countsByDirectory : metadataCountsByDirectory;
  const totalCount = hasSearchQuery ? searchTotalCount : archiveCount;
  const countForBucket = React.useCallback((bucket: ArchiveBucket): number | null => {
    if (!hasSearchQuery) return bucket.sessions.length;
    const counts = searchCountsByDirectory;
    if (!counts) return null;
    let count = 0;
    for (const [directory, directoryCount] of counts) {
      if (bucket.kind === 'space' && directory === bucket.directory) count += directoryCount;
      const topologyOwner = topologyWorktrees
        .filter((worktree) => directory === normalizePath(worktree.path))
        .sort((a, b) => (b.projectRoot?.length ?? 0) - (a.projectRoot?.length ?? 0))[0]?.projectRoot
        ?? projects.map((project) => normalizePath(project.path)).filter((root): root is string => root !== null && (directory === root || directory.startsWith(root + '/'))).sort((a, b) => b.length - a.length)[0];
      const session = ownershipCandidates.find((candidate) => normalizePath(resolveGlobalSessionDirectory(candidate)) === directory);
      const ownerRoot = topologyOwner ?? (session ? ownership.bySessionId.get(session.id)?.projectRoot : undefined);
      if (bucket.kind === 'project' && ownerRoot === bucket.directory) count += directoryCount;
      if (bucket.kind === 'other' && !ownerRoot && !spaceArchives?.has(directory)) count += directoryCount;
    }
    return count;
  }, [hasSearchQuery, ownership, ownershipCandidates, projects, searchCountsByDirectory, spaceArchives, topologyWorktrees]);

  const selectBucket = React.useCallback((directory: string | null) => {
    setSelectedKey(directory);
    if (hasSearchQuery) {
      const bucket = directory === null ? null : buckets.find((entry) => entry.key === directory);
      setSearchFilter('project', bucket?.kind === 'other' ? '__other__' : bucket?.directory ?? null);
    }
    setVisibleCount(PAGE_SIZE);
  }, [buckets, hasSearchQuery, setSearchFilter]);

  const openSession = React.useCallback((session: Session) => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    setCurrentSession(session.id, directory ?? undefined);
    onLeave();
  }, [onLeave, setCurrentSession]);

  const restoreSession = React.useCallback((session: Session) => {
    void unarchiveSession(session.id).then((success) => {
      if (success) {
        toast.success(t('sessions.sidebar.session.restore.success'));
      } else {
        toast.error(t('sessions.sidebar.session.restore.error'));
      }
    });
  }, [t, unarchiveSession]);

  const copySessionId = React.useCallback((sessionId: string) => {
    void copyTextToClipboard(sessionId)
      .then((result) => {
        if (result.ok) {
          toast.success(t('sessions.sidebar.session.copyId.success'));
          return;
        }
        toast.error(t('sessions.sidebar.session.copyId.error'));
      })
      .catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [t]);

  const setFilter = React.useCallback((key: keyof OmniFilters, value: string | null) => {
    setSearchFilter(key, value);
    setVisibleCount(PAGE_SIZE);
  }, [setSearchFilter]);
  const removeSearchFilter = React.useCallback((key: keyof OmniFilters) => {
    removeFilter(key);
    setVisibleCount(PAGE_SIZE);
  }, [removeFilter]);
  const clearSearchFilters = React.useCallback(() => {
    clearAll();
    setVisibleCount(PAGE_SIZE);
  }, [clearAll]);
  const commitSearchText = React.useCallback((next: string) => {
    setText(next, { commit: true });
    setVisibleCount(PAGE_SIZE);
  }, [setText]);
  const count = hasSearchQuery ? totalCount : filteredSessions.length;
  const countLabel = count === null ? null : count === 1
    ? t('sessions.archivePage.countSingle', { count })
    : t('sessions.archivePage.countPlural', { count });
  const projectOptions = React.useMemo(() => [
    ...projects.map((project) => ({ ...project, value: normalizePath(project.path) ?? project.path, label: formatProjectLabel(project.label?.trim() || project.path.split('/').filter(Boolean).pop() || project.path) })),
    { value: '__other__', label: t('sessions.archivePage.other') },
  ], [projects, t]);
  const worktreeOptions = React.useMemo(() => topologyWorktrees.map((worktree) => ({ value: worktree.label || worktree.branch || worktree.path, label: worktree.label || worktree.branch || worktree.path })), [topologyWorktrees]);
  const searchFilterDefaults = { lifecycle: 'archived', searchIn: 'everything', author: 'any' } as const;
  const chips = searchFilterChipKeys(filters, searchFilterDefaults).length > 0 ? <SearchFilterChips
    filters={filters}
    defaults={searchFilterDefaults}
    projectOptions={projectOptions}
    worktreeOptions={worktreeOptions}
    mobile={layout === 'mobile'}
    onRemove={removeSearchFilter}
  /> : undefined;
  const searchInput = (
    <SessionSearchInput
      value={text}
      onSearch={(next) => {
        setText(next);
        setVisibleCount(PAGE_SIZE);
      }}
      mode="live"
      mobile={layout === 'mobile'}
      placeholder={t('sessions.archivePage.searchPlaceholder')}
      clearLabel={t('sessions.sidebar.header.search.clear')}
      chips={chips}
      onRemoveLastChip={() => {
        const key = searchFilterChipKeys(filters, searchFilterDefaults).at(-1);
        if (key) removeSearchFilter(key);
      }}
      onClearFilters={clearSearchFilters}
      onCommit={commitSearchText}
    />
  );

  // An empty list is only "no archived sessions" once the session list has
  // actually loaded; before that, or after a failed load, say so instead.
  const emptyLabel = () => {
    if (archiveCount === 0 && sessionsStatus === 'error') return t('sessions.sidebar.group.empty.loadFailed');
    if (archiveCount === 0 && sessionsStatus !== 'ready') return t('sessions.sidebar.group.empty.loadingSessions');
    if (hasSearchQuery && (conversationSearch.contentStatus.kind === 'loading' || conversationSearch.contentStatus.kind === 'ready' && conversationSearch.contentStatus.indexing)) return t('search.omni.status.searching');
    return hasSearchQuery ? t('sessions.archivePage.empty.noMatches') : t('sessions.archivePage.empty.noArchived');
  };

  const emptyState = (
    <div className="py-10 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{emptyLabel()}</p>
    </div>
  );

  const hasMoreContent = conversationSearch.contentStatus.kind === 'ready' && conversationSearch.contentStatus.hasMore;
  const showMoreButton = remainingCount > 0 || (hasSearchQuery && hasMoreContent) ? (
    <button
      type="button"
      onClick={() => {
        setVisibleCount((count) => count + PAGE_SIZE);
        if (hasMoreContent) conversationSearch.loadMore();
      }}
      className={cn(
        'flex items-center justify-start rounded-md text-start text-muted-foreground leading-tight hover:text-foreground hover:underline',
        layout === 'mobile' ? 'min-h-10 px-3 typography-micro' : 'mt-1 px-2 py-1 text-xs',
      )}
    >
      {t('sessions.sidebar.group.showMore')}
    </button>
  ) : null;

  if (layout === 'mobile') {
    // The desktop's page in one column. Its groups (every session, each
    // project, a deleted space's chats, everything else) become a row of
    // chips that scrolls sideways; a project's archived worktrees are tiles
    // holding their sessions above its loose ones. Touch has no hover, so
    // Restore and a worktree's Delete are always shown. Deleting a session
    // stays on the desktop, whose confirmation dialog the mobile shell does
    // not mount.
    const renderMobileSessionRow = (session: Session, index: number, rows: Session[], inTile: boolean) => {
      const sessionDirectory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
      const title = session.title || t('sessions.sidebar.session.untitled');
      // A deleted space's chat has nowhere to be restored to.
      const restorable = !(spaceArchives?.has(sessionDirectory) ?? false);
      const parentTitle = parentTitleAbove(rows, index);
      // Only a list that mixes groups names each row's group.
      const showGroup = selectedBucket === null || hasSearchQuery;
      // In a worktree's tile the titles line up with the worktree's name, past its icon.
      const indent = inTile ? (session.parentID ? 'ps-[2.875rem]' : 'ps-[2.125rem]') : (session.parentID ? 'ps-7' : 'ps-4');
      return (
        <React.Fragment key={session.id}>
          {parentTitle ? (
            <p dir="auto" className={cn('truncate oc-ui-start-align pt-2 pe-2 typography-micro text-muted-foreground', inTile ? 'ps-[2.125rem]' : 'ps-4')}>{parentTitle}</p>
          ) : null}
          <div className="flex items-center pe-1.5">
            <button
              type="button"
              className={cn('flex min-h-10 min-w-0 flex-1 items-center py-1 pe-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', indent)}
              style={{ touchAction: 'manipulation' }}
              onClick={() => openSession(session)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span dir="auto" className="block truncate oc-ui-start-align typography-ui-label text-foreground">{title}</span>
                <span className="flex items-center gap-2.5 typography-micro text-muted-foreground">
                  {showGroup ? <span className="block min-w-0 flex-1 truncate">{labelOf(sessionDirectory)}</span> : null}
                  <span className="shrink-0 tabular-nums">
                    {formatSessionDateLabel(session.time?.archived ?? session.time?.updated ?? session.time?.created ?? Date.now())}
                  </span>
                </span>
              </span>
            </button>
            {restorable ? (
              <Button
                type="button"
                variant="ghost"
                size="lg"
                className="w-10 shrink-0 px-0 text-muted-foreground"
                onClick={() => restoreSession(session)}
                aria-label={t('sessions.archivePage.restoreSessionAria', { title })}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="inbox-unarchive" className="size-5" />
              </Button>
            ) : null}
          </div>
        </React.Fragment>
      );
    };
    const renderChip = (key: string, label: string, count: number | null, selected: boolean, onSelect: () => void, fromDeletedSpace = false) => (
      <Button
        key={key}
        type="button"
        variant="chip"
        size="sm"
        className="shrink-0"
        aria-pressed={selected}
        onClick={onSelect}
        style={{ touchAction: 'manipulation' }}
      >
        {fromDeletedSpace ? <Icon name="instance" className="size-3.5" /> : null}
        <span dir="auto" className="max-w-40 truncate">{label}</span>
        {count === null ? null : <span className="tabular-nums text-muted-foreground">{count}</span>}
      </Button>
    );
    return (
      <div data-archive-page="mobile" className="flex h-full min-h-0 flex-col">
        <div data-archive-toolbar className="shrink-0 space-y-2 pt-3">
          <div className="px-3">{searchInput}</div>
          <div className="px-3"><SearchScopeMenu filters={filters} defaults={searchFilterDefaults} options={{ lifecycle: true, project: null, searchIn: true, author: true }} projectOptions={projectOptions} worktreeOptions={worktreeOptions} onChange={setFilter} resultCount={totalCount} layout="mobile" /></div>
          <div className="px-3"><SearchStatusLine status={conversationSearch.contentStatus} count={totalCount} /></div>
          {/* Groups filter while not searching; a search spans them all. */}
          {!hasSearchQuery && buckets.length > 0 ? (
            <div className="flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
              {renderChip('__all__', t('sessions.archivePage.all'), archiveCount, selectedKey === null, () => selectBucket(null))}
              {buckets.map((bucket) => renderChip(
                bucket.key,
                bucket.label,
                countForBucket(bucket),
                selectedKey === bucket.key,
                () => selectBucket(bucket.key),
                bucket.kind === 'space',
              ))}
            </div>
          ) : null}
          {archiveCount > 0 || sessionsStatus === 'ready' ? (
            <p className="px-4 typography-micro text-muted-foreground">{countLabel}</p>
          ) : null}
        </div>
        <ScrollableOverlay
          outerClassName="min-h-0 flex-1"
          className="pt-1"
          style={{ paddingBottom: 'calc(0.5rem + var(--oc-safe-area-bottom, 0px))' }}
          disableHorizontal
        >
          {worktreeGroups.length > 0 ? (
            <div className={cn('space-y-2 px-3', visibleSessions.length > 0 && 'pb-3')}>
              {worktreeGroups.map(({ archive, sessions: groupSessions }) => (
                <div key={archive.id} className="oc-tile rounded-lg p-1">
                  <ArchivedWorktreeRow
                    archive={archive}
                    busy={archiveActions.busyIds.has(archive.id)}
                    touch
                    onRestore={() => { if (selectedProject) void archiveActions.restore(selectedProject, archive); }}
                    onDelete={() => { if (selectedProject) void archiveActions.remove(selectedProject, archive); }}
                  />
                  {groupSessions.map((session, index) => renderMobileSessionRow(session, index, groupSessions, true))}
                </div>
              ))}
            </div>
          ) : null}
          <div data-archive-search-results>
          {hasSearchQuery ? searchResults.length === 0 ? emptyState : searchResults.slice(0, visibleCount).map((result) => {
            const session = searchedSessionById.get(result.sessionId);
            const directory = result.directory ?? '';
            return <ArchiveSearchResultRow key={result.sessionId} result={result} query={normalizedQuery} context={archiveSearchResultContext({ result, mobile: true })} mobile restorable={Boolean(session?.time?.archived) && !(spaceArchives?.has(directory) ?? false)} onOpen={() => { void openSessionLink(result.sessionId, null); onLeave(); }} onOpenExcerpt={(messageId) => { void openSessionLink(result.sessionId, messageId); onLeave(); }} onRestore={() => { if (session) restoreSession(session); }} restoreLabel={t('sessions.archivePage.restoreSessionAria', { title: result.title })} lifecycle={lifecycle} author={effectiveAuthor} includeReasoning={messageSearchReasoningEnabled && showReasoningTraces} contentAvailable={messageSearchEnabled} />;
          }) : visibleSessions.length === 0 && worktreeGroups.length === 0
            ? emptyState
            : visibleSessions.map((session, index) => renderMobileSessionRow(session, index, visibleSessions, false))}
          {showMoreButton}
          </div>
        </ScrollableOverlay>
        {archiveActions.dialog}
      </div>
    );
  }

  const renderDirectoryItem = (
    key: string,
    label: string,
    count: number | null,
    isSelected: boolean,
    onSelect: () => void,
    fullPath?: string,
    sessionsForDelete?: Session[],
    fromDeletedSpace = false,
  ) => (
    <div key={key} className="group/dir relative">
      <button
        type="button"
        onClick={onSelect}
        title={fromDeletedSpace ? t('spaces.archive.groupTitle', { name: label }) : fullPath}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label transition-[padding] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          sessionsForDelete ? 'group-hover/dir:pe-8 group-focus-within/dir:pe-8' : '',
          isSelected
            ? 'bg-interactive-selection text-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
        )}
      >
        {fromDeletedSpace ? <Icon name="instance" className="h-3.5 w-3.5 flex-shrink-0" /> : null}
        <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate">{label}</span>
        {count === null ? null : <span className="flex-shrink-0 typography-micro text-muted-foreground">{count}</span>}
      </button>
      {sessionsForDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => sessionEvents.requestDelete({ sessions: sessionsForDelete, mode: 'session' })}
              className="absolute inset-e-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/dir:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('sessions.archivePage.deleteProjectAria', { label })}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>{t('sessions.archivePage.deleteProject')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );

  const renderSessionRow = (session: Session, index: number, rows: Session[], indent = false) => {
              const sessionDirectory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
              const directoryLabel = sessionDirectory ? labelOf(sessionDirectory) : null;
              // A deleted space's chat has nowhere to be restored to.
              const restorable = !(spaceArchives?.has(sessionDirectory) ?? false);
              const parentTitle = parentTitleAbove(rows, index);
              return (
                <React.Fragment key={session.id}>
                  {parentTitle ? (
                    <p dir="auto" className={cn('truncate oc-ui-start-align pt-2 pe-2 typography-micro text-muted-foreground', indent ? 'ps-[1.875rem]' : 'ps-2')}>{parentTitle}</p>
                  ) : null}
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={<div
                        className={cn(
                          'group relative flex cursor-pointer items-center gap-3 rounded-md py-1 pe-2 transition-[padding] hover:bg-interactive-hover/40 hover:pe-14 focus-within:pe-14',
                          // In a worktree's tile the titles line up with the worktree's name, past its icon.
                          indent ? (session.parentID ? 'ps-[2.875rem]' : 'ps-[1.875rem]') : (session.parentID ? 'ps-6' : 'ps-2'),
                        )}
                        onClick={() => openSession(session)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openSession(session);
                          }
                        }}
                      />}
                    >
                      <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label text-foreground">
                        {session.title || t('sessions.sidebar.session.untitled')}
                      </span>
                      {hasSearchQuery && directoryLabel ? (
                        <span className="max-w-40 flex-shrink-0 truncate text-[0.72rem] text-muted-foreground" title={sessionDirectory}>
                          {directoryLabel}
                        </span>
                      ) : null}
                      <span className="flex-shrink-0 text-[0.72rem] text-muted-foreground">
                        {formatSessionDateLabel(session.time?.archived ?? session.time?.updated ?? session.time?.created ?? Date.now())}
                      </span>
                      {restorable ? <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          restoreSession(session);
                        }}
                        className="absolute inset-e-7 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t('sessions.archivePage.restoreSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                      >
                        <Icon name="inbox-unarchive" className="h-3.5 w-3.5" />
                      </button> : null}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          sessionEvents.requestDelete({ sessions: [session], mode: 'session' });
                        }}
                        className="absolute inset-e-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-destructive group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t('sessions.archivePage.deleteSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                      >
                        <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-[180px]">
                      <ContextMenuItem className="[&>svg]:me-1" onClick={() => copySessionId(session.id)}>
                        <Icon name="file-copy" className="me-1 h-4 w-4" />
                        {t('sessions.sidebar.session.menu.copyId')}
                      </ContextMenuItem>
                      {restorable ? (
                        <ContextMenuItem className="[&>svg]:me-1" onClick={() => restoreSession(session)}>
                          <Icon name="inbox-unarchive" className="me-1 h-4 w-4" />
                          {t('sessions.sidebar.bulkActions.restore')}
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuItem
                        className="text-destructive focus:text-destructive [&>svg]:me-1"
                        onClick={() => sessionEvents.requestDelete({ sessions: [session], mode: 'session' })}
                      >
                        <Icon name="delete-bin" className="me-1 h-4 w-4" />
                        {t('sessions.sidebar.bulkActions.delete')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </React.Fragment>
              );
  };

  return (
    <div data-archive-page="desktop" className="@container absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* Directory filter panel */}
        <div className="hidden w-64 flex-shrink-0 flex-col border-e border-edge @min-[42rem]:flex">
          <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-0.5 p-2" disableHorizontal>
            {renderDirectoryItem(
              '__all__',
              t('sessions.archivePage.all'),
              hasSearchQuery ? totalCount : archiveCount,
              hasSearchQuery ? !filters.project : selectedKey === null,
              () => selectBucket(null),
            )}
            {buckets.map((bucket) => renderDirectoryItem(
              bucket.key,
              bucket.label,
              countForBucket(bucket),
                hasSearchQuery ? Boolean(filters.project && bucket.kind === 'project' && matchesProjectScope(filters.project, bucket.directory, bucket.projectId)) : selectedKey === bucket.key,
              () => selectBucket(bucket.key),
              bucket.directory || undefined,
              bucket.sessions.length > 0 ? bucket.sessions : undefined,
              bucket.kind === 'space',
            ))}
          </ScrollableOverlay>
        </div>

        {/* Session list */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The search shares the list's column, so the two line up. */}
          <div data-archive-toolbar className="px-6 pt-3">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
              <div className="min-w-0 flex-1">
                {searchInput}
              </div>
              <div className="hidden shrink-0 self-start items-center gap-1 @min-[42rem]:flex">
                <SearchFilterSelect filter="lifecycle" value={lifecycle} onChange={(value) => setFilter('lifecycle', value)} />
                <SearchFilterSelect filter="searchIn" value={searchIn} onChange={(value) => setFilter('searchIn', value)} />
                <SearchFilterSelect filter="author" value={author} onChange={(value) => setFilter('author', value)} />
              </div>
              <div className="min-w-0 max-w-[40%] shrink self-start @min-[42rem]:hidden [&_[data-search-scope-count]]:hidden"><SearchScopeMenu filters={filters} defaults={searchFilterDefaults} options={{ lifecycle: true, project: null, searchIn: true, author: true }} projectOptions={projectOptions} worktreeOptions={worktreeOptions} onChange={setFilter} resultCount={totalCount} layout="sidebar" /></div>
              {/* Pages have no close button: you leave via the sidebar. */}
              <span className="hidden h-8 flex-shrink-0 items-center self-start typography-micro text-muted-foreground @min-[42rem]:flex">
                {countLabel}
              </span>
            </div>
            <div className="mx-auto w-full max-w-3xl px-6"><SearchStatusLine status={conversationSearch.contentStatus} count={totalCount} /></div>
          </div>

          <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-6 py-3" disableHorizontal>
            <div data-archive-search-results className="mx-auto w-full max-w-3xl space-y-0.5">
              {/* Each archived worktree is a tile holding its sessions; the loose sessions follow. */}
              {worktreeGroups.length > 0 ? (
                <div className={cn('space-y-2', visibleSessions.length > 0 && 'pb-3')}>
                  {worktreeGroups.map(({ archive, sessions: groupSessions }) => (
                    <div key={archive.id} data-archive-worktree-tile={archive.id} className="oc-tile rounded-lg p-1">
                      <ArchivedWorktreeRow
                        archive={archive}
                        busy={archiveActions.busyIds.has(archive.id)}
                        onRestore={() => { if (selectedProject) void archiveActions.restore(selectedProject, archive); }}
                        onDelete={() => { if (selectedProject) void archiveActions.remove(selectedProject, archive); }}
                      />
                      {groupSessions.map((session, index) => renderSessionRow(session, index, groupSessions, true))}
                    </div>
                  ))}
                </div>
              ) : null}
              {hasSearchQuery ? searchResults.length === 0 ? emptyState : searchResults.slice(0, visibleCount).map((result) => {
                const session = searchedSessionById.get(result.sessionId);
                const directory = result.directory ?? '';
                const restorable = !result.archived || !(spaceArchives?.has(directory) ?? false);
                return <ArchiveSearchResultRow key={result.sessionId} result={result} query={normalizedQuery} context={archiveSearchResultContext({ result, mobile: false })} mobile={false} restorable={restorable && Boolean(session?.time?.archived)} onOpen={() => { void openSessionLink(result.sessionId, null); onLeave(); }} onOpenExcerpt={(messageId) => { void openSessionLink(result.sessionId, messageId); onLeave(); }} onRestore={() => { if (session) restoreSession(session); }} restoreLabel={t('sessions.archivePage.restoreSessionAria', { title: result.title })} lifecycle={lifecycle} author={effectiveAuthor} includeReasoning={messageSearchReasoningEnabled && showReasoningTraces} contentAvailable={messageSearchEnabled} />;
              }) : visibleSessions.length === 0 && worktreeGroups.length === 0
                ? emptyState
                : visibleSessions.map((session, index) => renderSessionRow(session, index, visibleSessions))}
              {showMoreButton}
            </div>
          </ScrollableOverlay>
        </div>
      </div>
      {archiveActions.dialog}
    </div>
  );
}

export function ArchiveView(): React.ReactNode {
  const open = useUIStore((state) => state.isArchivePageOpen);
  const initialQuery = useUIStore((state) => state.archivePageSearch);
  const openCount = useUIStore((state) => state.archivePageOpenCount);
  const setOpen = useUIStore((state) => state.setArchivePageOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  if (!open) return null;
  // Keyed by open, so a handed-over query lands even while the page is already on screen.
  return <ArchiveSessionsView key={openCount} layout="page" onLeave={leave} initialQuery={initialQuery} />;
}
