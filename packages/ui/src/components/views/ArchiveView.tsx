import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { formatSessionDateLabel, normalizePath } from '@/components/session/sidebar/utils';
import { useShallow } from 'zustand/react/shallow';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { refreshSpaceArchives, useSpaceArchivesStore } from '@/lib/spaces/space-archives';
import { isRestorableOnItsOwn } from '@/sync/session-restore-rule';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessions/sessionOwnership';
import { formatProjectLabel } from '@/components/session/sidebar/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { loadWorktreeArchives, useWorktreeArchivesByProject } from '@/lib/worktrees/worktreeArchive';
import { ArchivedWorktreeRow } from './archive/ArchivedWorktreeRow';
import { useWorktreeArchiveActions } from './archive/useWorktreeArchiveActions';

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
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  // Narrow selections: the cache's entity map changes with every active
  // session update, and the page only depends on which archived sessions are
  // listed and on their parents' titles.
  const listedSessions = useGlobalSessionsStore(useShallow((state) => state.archivedSessions
    .filter((session) => isRestorableOnItsOwn(session, state.entityById))));
  const parentTitlePairs = useGlobalSessionsStore(useShallow((state) => state.archivedSessions.flatMap((session) => {
    const parent = session.parentID ? state.entityById.get(session.parentID) : undefined;
    return parent ? [parent.id, parent.title] : [];
  })));
  const sessionsStatus = useGlobalSessionsStore((state) => state.status);
  const [query, setQuery] = React.useState(initialQuery);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  const spaceArchives = useSpaceArchivesStore((state) => state.byDirectory);

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

  const normalizedQuery = query.trim().toLowerCase();

  // A subsession under an archived parent comes back with that parent and is
  // not listed. One archived while its parent stays active would otherwise
  // show nowhere, so it is listed under its parent's title and restored alone.
  const sortedSessions = React.useMemo(
    () => [...listedSessions].sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0)),
    [listedSessions],
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

  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const openCodeProjects = useGlobalSyncStore((state) => state.projects);
  const archivesByProject = useWorktreeArchivesByProject();
  const archiveActions = useWorktreeArchiveActions();

  // Archived worktrees live in each project's repository; read them each time
  // the page opens, like the spaces above.
  React.useEffect(() => {
    for (const project of projects) void loadWorktreeArchives(project.path).catch(() => undefined);
  }, [projects]);

  // Sessions belong to their project the way the sidebar groups them: by
  // folder, then by OpenCode's project, which is what still places a session
  // of a worktree that is gone.
  const buckets = React.useMemo<ArchiveBucket[]>(() => {
    const ownership = createSessionOwnershipIndex(
      sortedSessions,
      projects.flatMap((project) => {
        const normalizedPath = normalizePath(project.path);
        return normalizedPath ? [{ id: project.id, normalizedPath }] : [];
      }),
      worktreesByProject,
      false,
      [],
      openCodeProjects,
    );
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
  }, [archivesByProject, labelOf, openCodeProjects, projects, sortedSessions, spaceArchives, t, worktreesByProject]);

  const selectedBucket = selectedKey === null ? null : buckets.find((bucket) => bucket.key === selectedKey) ?? null;
  const selectedProject = selectedBucket?.projectId ? { id: selectedBucket.projectId, path: selectedBucket.directory } : null;
  // The selected project's archived worktrees, each with its own sessions.
  const worktreeGroups = React.useMemo(() => {
    if (normalizedQuery || selectedBucket?.kind !== 'project') return [];
    const listed = new Map(selectedBucket.sessions.map((session) => [session.id, session] as const));
    return (archivesByProject.get(selectedBucket.directory)?.archives ?? []).map((archive) => ({
      archive,
      sessions: groupByParent(archive.sessionIds.flatMap((id) => {
        const session = listed.get(id);
        return session ? [session] : [];
      }).sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0))),
    }));
  }, [archivesByProject, normalizedQuery, selectedBucket]);
  const inWorktreeGroup = React.useMemo(
    () => new Set(worktreeGroups.flatMap((group) => group.sessions.map((session) => session.id))),
    [worktreeGroups],
  );

  // Search spans every archived session; the directory filter applies only
  // while not searching.
  const filteredSessions = React.useMemo(() => {
    if (normalizedQuery) {
      if (normalizedQuery.startsWith('ses_')) {
        return sortedSessions.filter((session) => session.id.toLowerCase() === normalizedQuery);
      }
      return groupByParent(rankByQuery(sortedSessions, normalizedQuery, (session) => [session.title]));
    }
    if (selectedBucket === null) return groupByParent(sortedSessions);
    return groupByParent(selectedBucket.sessions.filter((session) => !inWorktreeGroup.has(session.id)));
  }, [inWorktreeGroup, normalizedQuery, selectedBucket, sortedSessions]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const remainingCount = filteredSessions.length - visibleSessions.length;
  const totalCount = sortedSessions.length;

  const selectBucket = React.useCallback((directory: string | null) => {
    setSelectedKey(directory);
    setVisibleCount(PAGE_SIZE);
  }, []);

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

  const searchInput = (
    <SessionSearchInput
      value={query}
      onSearch={(next) => {
        setQuery(next);
        setVisibleCount(PAGE_SIZE);
      }}
      mobile={layout === 'mobile'}
      placeholder={t('sessions.archivePage.searchPlaceholder')}
      clearLabel={t('sessions.sidebar.header.search.clear')}
    />
  );

  const countLabel = filteredSessions.length === 1
    ? t('sessions.archivePage.countSingle', { count: filteredSessions.length })
    : t('sessions.archivePage.countPlural', { count: filteredSessions.length });

  // An empty list is only "no archived sessions" once the session list has
  // actually loaded; before that, or after a failed load, say so instead.
  const emptyLabel = () => {
    if (totalCount === 0 && sessionsStatus === 'error') return t('sessions.sidebar.group.empty.loadFailed');
    if (totalCount === 0 && sessionsStatus !== 'ready') return t('sessions.sidebar.group.empty.loadingSessions');
    return normalizedQuery ? t('sessions.archivePage.empty.noMatches') : t('sessions.archivePage.empty.noArchived');
  };

  const emptyState = (
    <div className="py-10 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{emptyLabel()}</p>
    </div>
  );

  const showMoreButton = remainingCount > 0 ? (
    <button
      type="button"
      onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
      className={cn(
        'flex items-center justify-start rounded-md text-start text-muted-foreground/70 leading-tight hover:text-foreground hover:underline',
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
      const showGroup = selectedBucket === null || normalizedQuery.length > 0;
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
    const renderChip = (key: string, label: string, count: number, selected: boolean, onSelect: () => void, fromDeletedSpace = false) => (
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
        {fromDeletedSpace ? <Icon name="box-3" className="size-3.5" /> : null}
        <span className="max-w-40 truncate">{label}</span>
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </Button>
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-2 pt-3">
          <div className="px-3">{searchInput}</div>
          {/* Groups filter while not searching; a search spans them all. */}
          {!normalizedQuery && buckets.length > 0 ? (
            <div className="flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
              {renderChip('__all__', t('sessions.archivePage.all'), totalCount, selectedKey === null, () => selectBucket(null))}
              {buckets.map((bucket) => renderChip(
                bucket.key,
                bucket.label,
                bucket.sessions.length,
                selectedKey === bucket.key,
                () => selectBucket(bucket.key),
                bucket.kind === 'space',
              ))}
            </div>
          ) : null}
          {totalCount > 0 || sessionsStatus === 'ready' ? (
            <p className="px-4 typography-micro text-muted-foreground">{countLabel}</p>
          ) : null}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto pt-1"
          style={{ paddingBottom: 'calc(0.5rem + var(--oc-safe-area-bottom, 0px))' }}
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
          {visibleSessions.length === 0 && worktreeGroups.length === 0
            ? emptyState
            : visibleSessions.map((session, index) => renderMobileSessionRow(session, index, visibleSessions, false))}
          {showMoreButton}
        </div>
        {archiveActions.dialog}
      </div>
    );
  }

  const renderDirectoryItem = (
    key: string,
    label: string,
    count: number,
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
        {fromDeletedSpace ? <Icon name="box-3" className="h-3.5 w-3.5 flex-shrink-0" /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 typography-micro text-muted-foreground/70">{count}</span>
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
                  <div
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
                  >
                    <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label text-foreground">
                      {session.title || t('sessions.sidebar.session.untitled')}
                    </span>
                    {normalizedQuery && directoryLabel ? (
                      <span className="max-w-40 flex-shrink-0 truncate text-[0.72rem] text-muted-foreground/70" title={sessionDirectory}>
                        {directoryLabel}
                      </span>
                    ) : null}
                    <span className="flex-shrink-0 text-[0.72rem] text-muted-foreground/75">
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
                  </div>
                </React.Fragment>
              );
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* Directory filter panel */}
        <div className="flex w-64 flex-shrink-0 flex-col border-e border-border/50">
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {renderDirectoryItem(
              '__all__',
              t('sessions.archivePage.all'),
              totalCount,
              selectedKey === null,
              () => selectBucket(null),
            )}
            {buckets.map((bucket) => renderDirectoryItem(
              bucket.key,
              bucket.label,
              bucket.sessions.length,
              selectedKey === bucket.key,
              () => selectBucket(bucket.key),
              bucket.directory || undefined,
              bucket.sessions.length > 0 ? bucket.sessions : undefined,
              bucket.kind === 'space',
            ))}
          </div>
        </div>

        {/* Session list */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The search shares the list's column, so the two line up. */}
          <div className="px-6 pt-3">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
              <div className="min-w-0 flex-1">
                {searchInput}
              </div>
              {/* Pages have no close button: you leave via the sidebar. */}
              <span className="flex h-8 flex-shrink-0 items-center self-start typography-micro text-muted-foreground">
                {countLabel}
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
            <div className="mx-auto w-full max-w-3xl space-y-0.5">
              {/* Each archived worktree is a tile holding its sessions; the loose sessions follow. */}
              {worktreeGroups.length > 0 ? (
                <div className={cn('space-y-2', visibleSessions.length > 0 && 'pb-3')}>
                  {worktreeGroups.map(({ archive, sessions: groupSessions }) => (
                    <div key={archive.id} className="oc-tile rounded-lg p-1">
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
              {visibleSessions.length === 0 && worktreeGroups.length === 0
                ? emptyState
                : visibleSessions.map((session, index) => renderSessionRow(session, index, visibleSessions))}
              {showMoreButton}
            </div>
          </div>
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
