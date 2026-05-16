import React from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useSync } from '@/sync/use-sync';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSwitcherItems, type SwitcherItem } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { useUIStore } from '@/stores/useUIStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { formatSessionCompactDateLabel, normalizePath, resolveSessionDiffStats } from './sidebar/utils';
import type { SessionNode, SessionSummaryMeta } from './sidebar/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SecondaryMeta = SwitcherItem['secondaryMeta'];

type SwitcherVariant = 'default' | 'compact';

type SessionSwitcherDropdownProps = {
  children: React.ReactNode;
  variant?: SwitcherVariant;
  scopeProjectId?: string | null;
  align?: 'start' | 'center' | 'end';
};

export function SessionSwitcherDropdown({
  children,
  variant = 'default',
  scopeProjectId = null,
  align = 'start',
}: SessionSwitcherDropdownProps): React.ReactElement {
  const isOpen = useUIStore((state) => state.isSessionDropdownOpen);
  const setOpen = useUIStore((state) => state.setSessionDropdownOpen);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className={cn(
          'overflow-hidden p-1 max-w-[calc(100vw-32px)]',
          variant === 'compact' ? 'w-[280px]' : 'w-[360px]',
        )}
      >
        {isOpen ? (
          <SwitcherContent
            onSelect={() => setOpen(false)}
            variant={variant}
            scopeProjectId={scopeProjectId}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SwitcherContentProps = {
  onSelect: () => void;
  variant: SwitcherVariant;
  scopeProjectId: string | null;
};

function SwitcherContent({ onSelect, variant, scopeProjectId }: SwitcherContentProps): React.ReactElement {
  const items = useSwitcherItems(true, { scopeProjectId });
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const ensureSessionRenderable = useSync().ensureSessionRenderable;
  const { t } = useI18n();

  const prefetchedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    // Prefetch only sessions that live in the currently mounted sync directory.
    // ensureSessionRenderable closes over SyncProvider's directory, so a cross-directory
    // call would hit the wrong backend context. Switching to such a session re-mounts
    // SyncProvider anyway, so the prefetch wouldn't have survived either way.
    const normalizedCurrent = normalizePath(currentDirectory);
    const queue: string[] = [];
    for (const item of items) {
      const id = item.node.session.id;
      if (id === currentSessionId) continue;
      if (prefetchedRef.current.has(id)) continue;
      const sessionDir = normalizePath(resolveGlobalSessionDirectory(item.node.session));
      if (!sessionDir || sessionDir !== normalizedCurrent) continue;
      prefetchedRef.current.add(id);
      queue.push(id);
    }
    if (queue.length === 0) return;

    let cancelled = false;
    const CONCURRENCY = 2;
    const runNext = async (): Promise<void> => {
      while (!cancelled) {
        const id = queue.shift();
        if (!id) return;
        try {
          await ensureSessionRenderable(id);
        } catch {
          // best-effort prefetch; ignore errors
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => runNext());
    void Promise.all(workers);

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, currentSessionId, ensureSessionRenderable, items]);

  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const toggleParent = React.useCallback((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  return (
    <div className="max-h-[60vh] overflow-y-auto">
      {items.length === 0 ? (
        <div className="px-3 py-4 text-center typography-meta text-muted-foreground">
          {t('sessions.switcher.empty')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {items.map((item) => (
            <SwitcherNode
              key={item.node.session.id}
              item={item}
              depth={0}
              variant={variant}
              expandedParents={expandedParents}
              toggleParent={toggleParent}
              closeDropdown={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type SwitcherNodeProps = {
  item: { node: SessionNode; projectId: string | null; groupDirectory: string | null; secondaryMeta: SecondaryMeta };
  depth: number;
  variant: SwitcherVariant;
  expandedParents: Set<string>;
  toggleParent: (sessionId: string) => void;
  closeDropdown: () => void;
};

function SwitcherNode({ item, depth, variant, expandedParents, toggleParent, closeDropdown }: SwitcherNodeProps): React.ReactElement {
  const { node, secondaryMeta } = item;
  const session = node.session;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedParents.has(session.id);

  return (
    <>
      <SwitcherRow
        session={session}
        depth={depth}
        variant={variant}
        secondaryMeta={secondaryMeta}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onToggleExpand={hasChildren ? () => toggleParent(session.id) : undefined}
        closeDropdown={closeDropdown}
      />
      {hasChildren && isExpanded
        ? node.children.map((childNode) => (
            <SwitcherNode
              key={childNode.session.id}
              item={{ node: childNode, projectId: item.projectId, groupDirectory: item.groupDirectory, secondaryMeta }}
              depth={depth + 1}
              variant={variant}
              expandedParents={expandedParents}
              toggleParent={toggleParent}
              closeDropdown={closeDropdown}
            />
          ))
        : null}
    </>
  );
}

type SwitcherRowProps = {
  session: Session;
  depth: number;
  variant: SwitcherVariant;
  secondaryMeta: SecondaryMeta;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggleExpand?: () => void;
  closeDropdown: () => void;
};

function SwitcherRow({ session, depth, variant, secondaryMeta, hasChildren, isExpanded, onToggleExpand, closeDropdown }: SwitcherRowProps): React.ReactElement {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);

  const sessionStatus = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);

  const isActive = currentSessionId === session.id;
  const sessionTitle = session.title?.trim() || t('sessions.sidebar.session.untitled');
  const isSubtask = Boolean((session as Session & { parentID?: string | null }).parentID);
  const needsAttention = unseenCount > 0 && (!isSubtask || notifyOnSubtasks);
  const statusType = sessionStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && needsAttention && !isActive;

  const summary = session.summary as SessionSummaryMeta | undefined;
  const diffStats = resolveSessionDiffStats(summary);
  const timestamp = session.time?.updated || session.time?.created || Date.now();
  const timeLabel = formatSessionCompactDateLabel(timestamp);

  const projectLabel = secondaryMeta?.projectLabel?.trim() || null;
  const rawBranchLabel = secondaryMeta?.branchLabel?.trim() || null;
  const branchLabel = rawBranchLabel && rawBranchLabel !== 'HEAD' ? rawBranchLabel : null;

  const handleSelect = React.useCallback(() => {
    if (isActive) {
      closeDropdown();
      return;
    }
    const directory = resolveGlobalSessionDirectory(session);
    setCurrentSession(session.id, directory ?? null);
    closeDropdown();
  }, [closeDropdown, isActive, session, setCurrentSession]);

  return (
    <BaseMenu.Item
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest('[data-switcher-expand]')) {
          event.preventDefault();
          return;
        }
        handleSelect();
      }}
      data-slot="session-switcher-item"
      className={cn(
        'group relative flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 outline-hidden select-none',
        'data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {variant === 'compact' && hasChildren ? (
            <span
              role="button"
              tabIndex={-1}
              data-switcher-expand
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpand?.();
              }}
              className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
              aria-label={isExpanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand')}
            >
              {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
            </span>
          ) : null}
          <span className={cn('truncate text-[14px] font-normal leading-tight', isActive ? 'text-primary' : 'text-foreground')}>
            {sessionTitle}
          </span>
        </div>
        {variant === 'default' ? (
          <div
            className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground/70 leading-tight"
            style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}
          >
            {hasChildren ? (
              <span
                role="button"
                tabIndex={-1}
                data-switcher-expand
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleExpand?.();
                }}
                className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
                aria-label={isExpanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand')}
              >
                {isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}
              </span>
            ) : null}
            <span className="flex-shrink-0">{timeLabel}</span>
            {projectLabel ? <span className="truncate">{projectLabel}</span> : null}
            {branchLabel ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                <span className="truncate">{branchLabel}</span>
              </span>
            ) : null}
            {diffStats ? (
              <span className="inline-flex flex-shrink-0 items-center gap-0 text-[0.92em]">
                <span className="text-status-success/80">+{diffStats.additions}</span>
                <span className="text-muted-foreground/60">/</span>
                <span className="text-status-error/65">-{diffStats.deletions}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {isStreaming || showUnreadDot ? (
        <span className="flex h-3 w-3 flex-shrink-0 items-center justify-center self-center">
          {isStreaming ? (
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary animate-busy-pulse"
              aria-label={t('sessions.sidebar.session.status.active')}
              title={t('sessions.sidebar.session.status.active')}
            />
          ) : (
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              aria-label={t('sessions.sidebar.session.status.unread')}
              title={t('sessions.sidebar.session.status.unread')}
            />
          )}
        </span>
      ) : null}
    </BaseMenu.Item>
  );
}
