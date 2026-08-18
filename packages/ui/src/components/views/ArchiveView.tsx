import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { Icon } from '@/components/icon/Icon';
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

type DirectoryBucket = {
  directory: string;
  label: string;
  sessions: Session[];
};

// Bound the mounted DOM: archives grow into the hundreds; batch rendering
// keeps the list responsive without a virtualizer.
const PAGE_SIZE = 100;

export function ArchiveView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isArchivePageOpen);
  const setOpen = useUIStore((state) => state.setArchivePageOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const archivedSessions = useGlobalSessionsStore(useShallow((state) => open ? state.archivedSessions : []));
  const [query, setQuery] = React.useState('');
  const [selectedDirectory, setSelectedDirectory] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);

  const normalizedQuery = query.trim().toLowerCase();

  const sortedSessions = React.useMemo(() => {
    if (!open) return [];
    return [...archivedSessions].sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0));
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
        label: directory
          ? (formatDirectoryName(directory, homeDirectory) || directory)
          : t('sessions.archivePage.otherProjects'),
        sessions: [session],
      });
    }
    return [...byDirectory.values()].sort((a, b) => b.sessions.length - a.sessions.length);
  }, [homeDirectory, sortedSessions, t]);

  // Search spans every archived session; the directory filter applies only
  // while not searching.
  const filteredSessions = React.useMemo(() => {
    if (normalizedQuery) {
      return sortedSessions.filter((session) => (session.title ?? '').toLowerCase().includes(normalizedQuery));
    }
    if (selectedDirectory === null) return sortedSessions;
    return buckets.find((bucket) => bucket.directory === selectedDirectory)?.sessions ?? [];
  }, [buckets, normalizedQuery, selectedDirectory, sortedSessions]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const remainingCount = filteredSessions.length - visibleSessions.length;
  const totalCount = archivedSessions.length;

  const selectDirectory = React.useCallback((directory: string | null) => {
    setSelectedDirectory(directory);
    setVisibleCount(PAGE_SIZE);
  }, []);

  const openSession = React.useCallback((session: Session) => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    setCurrentSession(session.id, directory ?? undefined);
    setActiveMainTab('chat');
    setOpen(false);
  }, [setActiveMainTab, setCurrentSession, setOpen]);

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

  const renderDirectoryItem = (
    key: string,
    label: string,
    count: number,
    isSelected: boolean,
    onSelect: () => void,
    fullPath?: string,
    sessionsForDelete?: Session[],
  ) => (
    <div key={key} className="group/dir relative">
      <button
        type="button"
        onClick={onSelect}
        title={fullPath}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label transition-[padding] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          sessionsForDelete ? 'group-hover/dir:pr-8 group-focus-within/dir:pr-8' : '',
          isSelected
            ? 'bg-interactive-selection text-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 typography-micro text-muted-foreground/70">{count}</span>
      </button>
      {sessionsForDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => sessionEvents.requestDelete({ sessions: sessionsForDelete, mode: 'session' })}
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/dir:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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
            ))}
          </div>
        </div>

        {/* Session list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-6 pt-3">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
                placeholder={t('sessions.archivePage.searchPlaceholder')}
                className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              />
            </div>
            {/* Pages have no close button: you leave via the sidebar. */}
            <span className="flex-shrink-0 typography-micro text-muted-foreground">
              {filteredSessions.length === 1
                ? t('sessions.archivePage.countSingle', { count: filteredSessions.length })
                : t('sessions.archivePage.countPlural', { count: filteredSessions.length })}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
            <div className="mx-auto w-full max-w-3xl space-y-0.5">
              {visibleSessions.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  <p className="typography-ui-label font-semibold">
                    {normalizedQuery ? t('sessions.archivePage.empty.noMatches') : t('sessions.archivePage.empty.noArchived')}
                  </p>
                </div>
              ) : visibleSessions.map((session) => {
                const sessionDirectory = normalizePath(resolveGlobalSessionDirectory(session)) ?? '';
                const directoryLabel = sessionDirectory
                  ? (formatDirectoryName(sessionDirectory, homeDirectory) || sessionDirectory)
                  : null;
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
                    <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
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
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        restoreSession(session);
                      }}
                      className="absolute right-7 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      aria-label={t('sessions.archivePage.restoreSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                    >
                      <Icon name="inbox-unarchive" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        sessionEvents.requestDelete({ sessions: [session], mode: 'session' });
                      }}
                      className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity pointer-events-none hover:text-destructive group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      aria-label={t('sessions.archivePage.deleteSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              {remainingCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  className="mt-1 flex items-center justify-start rounded-md px-2 py-1 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {t('sessions.sidebar.group.showMore')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
