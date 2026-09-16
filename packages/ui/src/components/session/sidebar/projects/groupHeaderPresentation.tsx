import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { CollapsedSessionActivityIndicator } from '../sessions/collapsedActivityIndicator';
import type { SortableDragHandleProps } from './sortableItems';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import type { SessionGroup, SessionNode } from '../types';
import { isBranchDifferentFromLabel, normalizePath, renderHighlightedText } from '../utils';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useI18n } from '@/lib/i18n';

/**
 * Single source of presentation semantics for the sidebar's two header kinds:
 * the worktree/archived group header (shared by the normal sidebar and the
 * search rows) and the activity zone header (shared by the normal activity
 * sections and the search rows). Geometry, icons, hover/focus behavior,
 * alwaysShowActions behavior, PR presentation, action placement, and aria
 * labels exist exactly once, here.
 *
 * Consumers keep their own `oc-group` wrapper, body, and dialogs. The
 * `data-gh-icon-*` attributes mark the static/arrow icon-swap slots so
 * behavior tests can assert the alwaysShowActions parity without matching
 * on class spellings.
 */

type OpenNewSessionDraftOptions = {
  selectedProjectId?: string | null;
  directoryOverride?: string | null;
  targetFolderId?: string;
  target?: 'chat' | 'project';
};

type SidebarGroupHeaderPresentationProps = {
  group: SessionGroup;
  /** Search text for label highlighting; empty in normal mode. */
  labelQuery: string;
  isCollapsed: boolean;
  onToggle: () => void;
  alwaysShowActions: boolean;
  /**
   * Source nodes feeding the collapsed activity indicator. Only rendered
   * while the group is collapsed.
   */
  collapsedActivityNodes: SessionNode[];
  notifyOnSubtasks: boolean;
  /** Flat session list backing the header's delete actions. */
  allGroupSessions: readonly Session[];
  projectId?: string | null;
  activeProjectId: string | null;
  mobileVariant: boolean;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: OpenNewSessionDraftOptions) => void;
  /**
   * Optional drag-handle listeners/ref for the sortable group header
   * (normal sidebar only; applied to the inner label container).
   */
  dragHandleProps?: SortableDragHandleProps | null;
};

/**
 * The group header's label rows and action buttons, shared by the normal
 * worktree group header and the search-mode group header. Covers only the
 * `group/gh` header: callers own the `oc-group` wrapper, the body, and any
 * dialog.
 */
export const SidebarGroupHeaderPresentation: React.FC<SidebarGroupHeaderPresentationProps> = ({
  group,
  labelQuery,
  isCollapsed,
  onToggle,
  alwaysShowActions,
  collapsedActivityNodes,
  notifyOnSubtasks,
  allGroupSessions,
  projectId,
  activeProjectId,
  mobileVariant,
  setActiveProjectIdOnly,
  setSessionSwitcherOpen,
  openNewSessionDraft,
  dragHandleProps,
}) => {
  const { t } = useI18n();
  const prKey = React.useMemo(() => {
    if (group.isMain || group.isArchivedBucket) return null;
    const directory = normalizePath(group.directory ?? null);
    const branch = group.branch?.trim();
    return directory && branch ? getGitHubPrStatusKey(directory, branch) : null;
  }, [group.branch, group.directory, group.isArchivedBucket, group.isMain]);
  const prSummary = usePrVisualSummary(prKey);
  const prColor = prSummary ? `var(--pr-${prSummary.visualState})` : undefined;
  // git still registers this worktree but its directory is gone. The group
  // stays so its sessions remain reachable (opening one relocates it); the
  // icon tells the user why the folder is not there.
  const worktreeMissingIndicator = group.worktree?.worktreeStatus === 'missing' ? (
    <span
      className="inline-flex flex-shrink-0 items-center text-status-warning"
      title={t('sessions.sidebar.group.worktreeMissing')}
      aria-label={t('sessions.sidebar.group.worktreeMissing')}
    >
      <Icon name="alert" className="h-3 w-3" />
    </span>
  ) : null;
  // Reserve room for the hover-revealed header actions (new draft + delete
  // worktree) so they never overlap the label / PR badge.
  const hasWorktreeDeleteAction = Boolean(!group.isMain && group.worktree);
  const groupHeaderRightPadding = alwaysShowActions
    ? (hasWorktreeDeleteAction ? 'pr-14' : 'pr-7')
    : (hasWorktreeDeleteAction
        ? 'pr-2 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
        : 'pr-2 group-hover/gh:pr-7 group-focus-within/gh:pr-7');
  // The static icon makes way for the collapse arrow on hover; touch
  // layouts (alwaysShowActions) keep the toggle affordance always visible
  // instead.
  const staticIconVisibilityClass = alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden';
  const arrowVisibilityClass = alwaysShowActions
    ? 'inline-flex'
    : 'hidden group-hover/gh:inline-flex';
  const groupActivityIndicator = isCollapsed
    ? <CollapsedSessionActivityIndicator nodes={collapsedActivityNodes} includeUnreadSubtasks={notifyOnSubtasks} />
    : null;
  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  // SAFETY: null is the intentional no-color branch for a status line.
  const statusLine = group.branch && isBranchDifferentFromLabel(group.branch, group.label)
    ? { label: group.branch }
    : null;
  return (
    <div
      className={cn('group/gh relative flex items-start justify-between gap-1 py-1 min-w-0 rounded-md', 'cursor-pointer')}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      aria-label={isCollapsed
        ? t('sessions.sidebar.group.expandAria', { label: group.label })
        : t('sessions.sidebar.group.collapseAria', { label: group.label })}
      aria-expanded={!isCollapsed}
    >
      <div
        ref={dragHandleProps?.setActivatorNodeRef}
        className={cn(
          // pl-1.5 lines the branch icon up with the project-zone header
          // icon (container pl-2.5 + 6px = band pl-4 past its -ml-2.5).
          'min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-1.5 transition-[padding]',
          groupHeaderRightPadding,
        )}
        {...(dragHandleProps?.listeners ?? {})}
      >
        <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
          <p className="typography-ui-label font-normal truncate text-foreground/92">
            {group.isArchivedBucket ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <Icon name="archive" data-gh-icon-static="archive" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', staticIconVisibilityClass)} />
                  <span data-gh-icon-swap="archive" className={cn(
                    'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                    arrowVisibilityClass,
                  )}>
                    {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, labelQuery)}</span>
                {worktreeMissingIndicator}
                {groupActivityIndicator}
              </span>
            ) : (!group.isMain || group.worktree) ? (
              // Worktree sub-header in the flat visual language: slim
              // folder-style row with a PR-tinted branch icon and PR badge.
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <Icon name="git-branch" data-gh-icon-static="git-branch"
                    className={cn('h-3.5 w-3.5 shrink-0', !prColor && 'text-muted-foreground', staticIconVisibilityClass)}
                    style={prColor ? { color: prColor } : undefined}
                  />
                  <span data-gh-icon-swap="git-branch" className={cn(
                    'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                    arrowVisibilityClass,
                  )}>
                    {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                  </span>
                </span>
                <span className="min-w-0 truncate typography-ui-label font-semibold text-muted-foreground">
                  {renderHighlightedText(group.label, labelQuery)}
                </span>
                {worktreeMissingIndicator}
                {groupActivityIndicator}
                {prSummary ? (
                  <span
                    className="ml-auto flex-shrink-0 text-[0.72rem] font-medium leading-none"
                    style={prColor ? { color: prColor } : undefined}
                  >
                    #{prSummary.number}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <span className="min-w-0 truncate">{renderHighlightedText(group.label, labelQuery)}</span>
                {groupActivityIndicator}
              </span>
            )}
          </p>
          {showBranchSubtitle && statusLine ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight">
              {group.isArchivedBucket ? (
                <Icon name="archive" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              ) : (
                <Icon name="git-branch" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/80">
                {statusLine.label}
              </span>
            </span>
          ) : null}
        </div>
        {!group.isArchivedBucket && group.directory ? <DirectoryActionIndicator directory={group.directory} className="self-center" /> : null}
      </div>
      {group.isArchivedBucket && allGroupSessions.length > 0 ? (
        <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  sessionEvents.requestDelete({
                    sessions: [...allGroupSessions],
                    mode: 'session',
                  });
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={t('sessions.sidebar.group.actions.deleteArchivedInGroupAria', { label: group.label })}
              >
                <Icon name="delete-bin" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.deleteArchivedSessions')}</p></TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {group.directory && !group.isMain && group.worktree ? (
        <div className={cn('absolute right-7 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  sessionEvents.requestDelete({
                    sessions: [...allGroupSessions],
                    mode: 'worktree',
                    worktree: group.worktree,
                  });
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={t('sessions.sidebar.group.actions.deleteGroupAria', { label: group.label })}
              >
                <Icon name="delete-bin" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.deleteWorktree')}</p></TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {group.directory ? (
        <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
                  if (mobileVariant) setSessionSwitcherOpen(false);
                  openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
               >
                 <Icon name="add" className="h-4 w-4" />
               </button>
             </TooltipTrigger>
             <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.project.actions.newDraftSession')}</p></TooltipContent>
           </Tooltip>
         </div>
       ) : null}
    </div>
  );
};

type SidebarActivityHeaderPresentationProps = {
  title: string;
  icon: IconName;
  isCollapsed: boolean;
  onToggle: () => void;
  showNewChat: boolean;
  onNewChat?: () => void;
  alwaysShowActions: boolean;
  /** Applies the sticky zone-header chrome and its DOM marker. */
  isSticky: boolean;
  /** Extra wrapper classes owned by the consuming surface (margins, spacing). */
  className?: string;
  /**
   * When set, the toggle button carries the sticky sentinel attribute
   * (search rows: virtualized headers appear/disappear, so the sticky
   * observers need the attribute on the mounted element itself).
   */
  activityStartKey?: 'chats' | 'active-now';
  /** Chats reserves extra right padding for the new-chat button. */
  isChats: boolean;
  /** Toggle-button aria-label; the normal section header leaves it off. */
  toggleAriaLabel?: string;
};

/**
 * The activity zone header (Chats / Recent): toggle button with the
 * hover icon swap, the zone title, and the hover-revealed new-chat action.
 */
export const SidebarActivityHeaderPresentation: React.FC<SidebarActivityHeaderPresentationProps> = ({
  title,
  icon,
  isCollapsed,
  onToggle,
  showNewChat,
  onNewChat,
  alwaysShowActions,
  isSticky,
  className,
  activityStartKey,
  isChats,
  toggleAriaLabel,
}) => {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'group/chats relative',
        className,
        isSticky && 'sticky top-0 z-20 bg-sidebar',
      )}
      data-sidebar-sticky-header={isSticky ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'group flex w-full items-center gap-1.5 py-1 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isChats ? 'pr-10' : 'pr-3.5',
        )}
        aria-expanded={!isCollapsed}
        aria-label={toggleAriaLabel}
        data-sidebar-activity-start={activityStartKey}
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          <Icon name={icon} className={cn('h-3.5 w-3.5 text-muted-foreground/80', 'group-hover:hidden')} />
          <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
            {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
          </span>
        </span>
        <span className="typography-ui-label font-semibold lowercase text-foreground">
          {title}
        </span>
      </button>
      {showNewChat ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onNewChat?.(); }}
          className={cn(
            'absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-focus-within/chats:opacity-100 group-focus-within/chats:pointer-events-auto',
          )}
          aria-label={t('sessions.sidebar.header.actions.newSession')}
        >
          <Icon name="add" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
};