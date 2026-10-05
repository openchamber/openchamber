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

type DirectoryBucket = {
  directory: string;
  label: string;
  sessions: Session[];
  // The chats of a deleted isolated space: named after the space, with no way to restore them.
  fromDeletedSpace: boolean;
};

// Bound the mounted DOM: archives grow into the hundreds; batch rendering
// keeps the list responsive without a virtualizer.
const PAGE_SIZE = 100;

/**
 * The archive itself. `page` is the desktop surface that replaces the chat
 * area; `mobile` is the single-column list inside the phone's fullscreen
 * surface. `onLeave` runs once an archived session has been opened.
 */
export function ArchiveSessionsView({ open, layout, onLeave }: {
  open: boolean;
  layout: 'page' | 'mobile';
  onLeave: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const archivedSessions = useGlobalSessionsStore(useShallow((state) => open ? state.archivedSessions : []));
  const sessionsStatus = useGlobalSessionsStore((state) => state.status);
  const [query, setQuery] = React.useState('');
  const [selectedDirectory, setSelectedDirectory] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  const spaceArchives = useSpaceArchivesStore((state) => state.byDirectory);

  // The chats of deleted spaces are read-only and named after their space; read which they are
  // each time the page opens, since a space may have been deleted from another window.
  React.useEffect(() => {
    if (open) void refreshSpaceArchives().catch(() => {});
  }, [open]);

  const labelOf = React.useCallback((directory: string): string => {
    const archive = spaceArchives?.get(directory);
    if (archive) return archive.name;
    return directory ? (formatDirectoryName(directory, homeDirectory) || directory) : t('sessions.archivePage.otherProjects');
  }, [homeDirectory, spaceArchives, t]);

  const normalizedQuery = query.trim().toLowerCase();

  const sortedSessions = React.useMemo(() => {
    if (!open) return [];
    // Subsessions are restored with their parent and never listed on their own.
    return archivedSessions
      .filter((session) => !session.parentID)
      .sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0));
  }, [archivedSessions, open]);

  const buckets = React.useMemo<DirectoryBucket[]>(() => {
    const byDirectory = new Map<string, DirectoryBucket>();
    for (const session of sortedSessions) {
      const directory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
      const existing = byDirectory.get(directory);
      if (existing) {
        existing.sessions.push(session);
        continue;
      }
      byDirectory.set(directory, {
        directory,
        label: labelOf(directory),
        sessions: [session],
        fromDeletedSpace: spaceArchives?.has(directory) ?? false,
      });
    }
    return [...byDirectory.values()].sort((a, b) => b.sessions.length - a.sessions.length);
  }, [labelOf, sortedSessions, spaceArchives]);

  // Search spans every archived session; the directory filter applies only
  // while not searching.
  const filteredSessions = React.useMemo(() => {
    if (normalizedQuery) {
      if (normalizedQuery.startsWith('ses_')) {
        return sortedSessions.filter((session) => session.id.toLowerCase() === normalizedQuery);
      }
      return rankByQuery(sortedSessions, normalizedQuery, (session) => [session.title]);
    }
    if (selectedDirectory === null) return sortedSessions;
    return buckets.find((bucket) => bucket.directory === selectedDirectory)?.sessions ?? [];
  }, [buckets, normalizedQuery, selectedDirectory, sortedSessions]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const remainingCount = filteredSessions.length - visibleSessions.length;
  const totalCount = sortedSessions.length;

  const selectDirectory = React.useCallback((directory: string | null) => {
    setSelectedDirectory(directory);
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

  if (!open) return null;

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
        'flex items-center justify-start rounded-md text-left text-muted-foreground/70 leading-tight hover:text-foreground hover:underline',
        layout === 'mobile' ? 'min-h-10 px-3 typography-micro' : 'mt-1 px-2 py-1 text-xs',
      )}
    >
      {t('sessions.sidebar.group.showMore')}
    </button>
  ) : null;

  if (layout === 'mobile') {
    // One column: no directory panel, so every row names its project. Touch
    // has no hover, so Restore is always visible. Deleting stays on desktop,
    // whose confirmation dialog the mobile shell does not mount.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-1.5 px-3 pt-3">
          {searchInput}
          {totalCount > 0 || sessionsStatus === 'ready' ? (
            <p className="px-1 typography-micro text-muted-foreground">{countLabel}</p>
          ) : null}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto pt-1"
          style={{ paddingBottom: 'calc(0.5rem + var(--oc-safe-area-bottom, 0px))' }}
        >
          {visibleSessions.length === 0 ? emptyState : visibleSessions.map((session) => {
            const sessionDirectory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
            const title = session.title || t('sessions.sidebar.session.untitled');
            // A deleted space's chat has nowhere to be restored to.
            const restorable = !(spaceArchives?.has(sessionDirectory) ?? false);
            return (
              <div key={session.id} className="flex items-center pr-1.5">
                <button
                  type="button"
                  className="flex min-h-10 min-w-0 flex-1 items-center py-1 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  style={{ touchAction: 'manipulation' }}
                  onClick={() => openSession(session)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto" className="block truncate text-left typography-ui-label text-foreground">
                      {title}
                    </span>
                    <span className="flex items-center gap-2.5 typography-micro text-muted-foreground">
                      <span className="block min-w-0 flex-1 truncate">{labelOf(sessionDirectory)}</span>
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
            );
          })}
          {showMoreButton}
        </div>
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
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label transition-[padding] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          sessionsForDelete ? 'group-hover/dir:pr-8 group-focus-within/dir:pr-8' : '',
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
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/dir:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* Directory filter panel */}
        <div className="flex w-64 flex-shrink-0 flex-col border-r border-border/50">
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {renderDirectoryItem(
              '__all__',
              t('sessions.archivePage.allDirectories'),
              totalCount,
              selectedDirectory === null,
              () => selectDirectory(null),
            )}
            {buckets.map((bucket) => renderDirectoryItem(
              bucket.directory || '__none__',
              bucket.label,
              bucket.sessions.length,
              selectedDirectory === bucket.directory,
              () => selectDirectory(bucket.directory),
              bucket.directory || undefined,
              bucket.sessions,
              bucket.fromDeletedSpace,
            ))}
          </div>
        </div>

        {/* Session list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-6 pt-3">
            <div className="min-w-0 flex-1">
              {searchInput}
            </div>
            {/* Pages have no close button: you leave via the sidebar. */}
            <span className="flex h-8 flex-shrink-0 items-center self-start typography-micro text-muted-foreground">
              {countLabel}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
            <div className="mx-auto w-full max-w-3xl space-y-0.5">
              {visibleSessions.length === 0 ? emptyState : visibleSessions.map((session) => {
                const sessionDirectory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
                const directoryLabel = sessionDirectory ? labelOf(sessionDirectory) : null;
                // A deleted space's chat has nowhere to be restored to.
                const restorable = !(spaceArchives?.has(sessionDirectory) ?? false);
                return (
                  <div
                    key={session.id}
                    className="group relative flex cursor-pointer items-center gap-3 rounded-md py-1 pl-2 pr-2 transition-[padding] hover:bg-interactive-hover/40 hover:pr-14 focus-within:pr-14"
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
                    <span dir="auto" className="min-w-0 flex-1 truncate text-left typography-ui-label text-foreground">
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
                      className="absolute right-7 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-destructive group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={t('sessions.archivePage.deleteSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              {showMoreButton}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ArchiveView(): React.ReactNode {
  const open = useUIStore((state) => state.isArchivePageOpen);
  const setOpen = useUIStore((state) => state.setArchivePageOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  return <ArchiveSessionsView open={open} layout="page" onLeave={leave} />;
}
