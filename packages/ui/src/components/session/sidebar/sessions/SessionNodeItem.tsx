import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ContextMenu as ContextMenuRoot } from '@/components/ui/context-menu';
import { openContextMenuFromKeyboard } from '@/components/ui/contextMenuKeyboard';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isSessionPinned } from '@/lib/sessionPins';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { openGuestUrl } from '@/lib/guests/open-url';
import type { RowGuestMark } from '@/lib/guests/marks';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getSessionActivityTime } from '@/sync/session-ordering';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useUIStore } from '@/stores/useUIStore';
import { DraggableSessionRow } from '../folders/sessionFolderDnd';
import { listedChildren } from '../listedChildren';
import { isPinnedZoneRowKey, sessionExpansionKey } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel, formatSessionDateLabel } from '../utils';
import { DirectoryActionIndicator } from './DirectoryActionIndicator';
import { GuestRowMarks } from './GuestRowMarks';
import { SessionLeadToggle, SessionTreeChevron } from './SessionRowChevrons';
import { SessionRowActions } from './SessionRowActions';
import { SessionRowPrBadge } from './SessionRowPrBadge';
import { SessionRowRename } from './SessionRowRename';
import { SessionRowTooltipBody } from './SessionRowTooltipBody';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { withOperatorChildrenCount } from './operatorChildrenBadges';
import { areSessionNodeItemPropsEqual } from './sessionNodeItemMemo';
import type { SessionNodeItemProps } from './sessionNodeItemProps';
import { resolveSessionRowActionLayout, resolveSessionRowLines } from './sessionRowLayout';
import { DoneHintMark, PendingRequestBadges, PinnedMark, SessionActionSpinner, SessionGoalMark } from './sessionRowMarks';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from './sessionTreeGeometry';
import { useScrollDismissedTooltip } from './useScrollDismissedTooltip';
import { useSessionRowContext } from './useSessionRowContext';
import { useSessionRowInteractions } from './useSessionRowInteractions';
import { useSessionRowLiveState } from './useSessionRowLiveState';
import { useSessionRowMenus } from './useSessionRowMenus';
import { useSessionRowPlace } from './useSessionRowPlace';
import { useSessionRowRename } from './useSessionRowRename';
import { useSessionRowWork } from './useSessionRowWork';

export type { SessionNodeItemProps } from './sessionNodeItemProps';

function SessionNodeItemComponent(props: SessionNodeItemProps): React.ReactNode {
  streamPerfCount('ui.sidebar_session_node.render');
  const { t } = useI18n();
  const {
    node,
    depth = 0,
    ownsWork,
    groupDirectory,
    projectId,
    folderOwnerKey,
    ownerProjectId,
    selectionScopeKey: explicitSelectionScopeKey,
    archivedBucket = false,
    pinnedSessionIds,
    expandedParents,
    editingId,
    editingRowKey,
    setEditingId,
    setEditingRowKey,
    editTitle,
    setEditTitle,
    handleSaveEdit,
    handleCancelEdit,
    toggleParent,
    handleSessionSelect,
    handleSessionDoubleClick,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    createFolderAndStartRename,
    handleDeleteSession,
    handleRestoreSession,
    startSessionWorktreeMenuLoad,
    mobileVariant,
    alwaysShowActions,
    secondaryMeta,
    renderContext = 'project',
    detailed = false,
    repeat = false,
    blockingBadgeSessionScopes: timelineBadgeSessionScopes,
    rowKey,
    dragKey,
    children,
  } = props;
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const rowTooltip = useScrollDismissedTooltip();
  const session = node.session;
  const { isOneLineTimelineRow, isTwoLineRow, isTimelineRow, isZoneRow } = resolveSessionRowLines(renderContext, detailed);
  // The Pinned section's header already says its rows are pinned; anywhere
  // else a pinned session carries the mark.
  const hidePinnedMarker = rowKey !== undefined && isPinnedZoneRowKey(rowKey);

  const {
    isCurrentSession,
    isActive,
    sessionDirectory,
    sessionProjectId,
    projectRootDirectory,
    trackerDirectory,
    selectionScopeKey,
    hasFolderMutationAuthority,
  } = useSessionRowPlace({ session, groupDirectory, projectId, ownerProjectId, selectionScopeKey: explicitSelectionScopeKey, folderOwnerKey });
  const {
    timelineProject,
    tooltipProjectLabel,
    tooltipBranchLabel,
    branchInSpace,
    refLines,
    branchPrIconColor,
    primaryRef,
    moreRefCount,
    guestMarks,
  } = useSessionRowContext({ node, projectId, secondaryMeta, renderContext, archivedBucket, isVSCode, sessionDirectory, sessionProjectId, projectRootDirectory });

  const sessionRowKey = rowKey ?? session.id;
  const isEditing = editingId === session.id && editingRowKey === sessionRowKey;
  const legacyContextKey = sessionExpansionKey(renderContext, archivedBucket, session.id);
  const menuInstanceKey = rowKey ? `session-menu:${rowKey}` : legacyContextKey;
  const contextMenuInstanceKey = rowKey ? `session-context:${rowKey}` : null;
  const sessionGoal = getSessionGoal(session);
  const sessionTitle = session.title || t('sessions.sidebar.session.untitled');
  // Every row opens to its subsessions, Chats, Pinned and In work rows
  // included, detailed or not.
  const hasChildren = listedChildren(node).length > 0;
  const isPinnedSession = isSessionPinned(pinnedSessionIds, sessionDirectory, session.id);
  // Per-render-context expansion key: the same session can appear in both
  // the project's root and the "Recent" list, and expanding one should not
  // expand the other. Matches the format of menuInstanceKey.
  const expansionKey = legacyContextKey;
  const isExpanded = expandedParents.has(expansionKey);

  const {
    isZombie,
    turnActivity,
    isStreaming,
    isAiRenaming,
    isSessionActionPending,
    hasPendingPermission,
    hasPendingForm,
    needsAttention,
    showUnreadStatus,
    showStatusMarker,
    showActivityDuration,
    waitingOnUser,
  } = useSessionRowLiveState({ node, sessionDirectory, isExpanded, isActive, timelineBadgeSessionScopes });
  const { canTrackWork, isInWork, showDoneHint, toggleWork } = useSessionRowWork({
    node,
    ownsWork,
    archivedBucket,
    groupDirectory,
    pinnedSessionIds,
    sessionDirectory,
    isStreaming,
  });
  const menus = useSessionRowMenus({
    node,
    sessionDirectory,
    sessionTitle,
    sessionRowKey,
    menuInstanceKey,
    contextMenuInstanceKey,
    archivedBucket,
    isPinnedSession,
    canTrackWork,
    isInWork,
    toggleWork,
    projectId,
    sessionProjectId,
    folderOwnerKey,
    hasFolderMutationAuthority,
    isZoneRow,
    mobileVariant,
    editingId,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    setEditingId,
    setEditingRowKey,
    setEditTitle,
    createFolderAndStartRename,
    handleDeleteSession,
    handleRestoreSession,
    startSessionWorktreeMenuLoad,
  });
  const { isContextMenuOpen, isSessionMenuOpen } = menus;
  const actionLayout = resolveSessionRowActionLayout({
    isVSCode,
    alwaysShowActions,
    archivedBucket,
    mobileVariant,
    canTrackWork,
    isTimelineRow,
    isOneLineTimelineRow,
    isSessionMenuOpen,
  });
  const { formRef, renameInputRef } = useSessionRowRename({ isEditing, sessionRowKey, editTitle, handleSaveEdit });
  const interactions = useSessionRowInteractions({
    node,
    sessionDirectory,
    sessionTitle,
    sessionRowKey,
    selectionScopeKey,
    archivedBucket,
    isActive,
    isVSCode,
    mobileVariant,
    needsAttention,
    handleSessionSelect,
  });
  const { isRowSelected, selectionModeEnabled } = interactions;
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);

  // The last conversation, as the list orders by: a rename or a metadata
  // write must not make an old session read as just used.
  const sessionTimestamp = getSessionActivityTime(session) || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const goalMark = sessionGoal ? <SessionGoalMark goal={sessionGoal} /> : null;

  if (isEditing) {
    return (
      <SessionRowRename
        sessionRowKey={sessionRowKey}
        depth={depth}
        isTwoLineRow={isTwoLineRow}
        isOneLineTimelineRow={isOneLineTimelineRow}
        isActive={isActive}
        repeat={repeat}
        timelineProject={timelineProject}
        tooltipProjectLabel={tooltipProjectLabel}
        tooltipBranchLabel={tooltipBranchLabel}
        branchInSpace={branchInSpace}
        primaryRef={primaryRef}
        moreRefCount={moreRefCount}
        goal={goalMark}
        draft={editTitle}
        setDraft={setEditTitle}
        onSave={handleSaveEdit}
        onCancel={handleCancelEdit}
        formRef={formRef}
        inputRef={renameInputRef}
      />
    );
  }

  const { alwaysActionPaddingClass, vscodeAlwaysActionPaddingClass, showQuickArchiveAction } = actionLayout;
  // Running indicators are static by default; the local appearance preference
  // enables stepped motion without changing the elapsed-turn counter.
  const liveStateMark = isSessionActionPending
    ? <SessionActionSpinner aiRenaming={isAiRenaming} />
    : showStatusMarker && !waitingOnUser ? <SessionActivityIndicator state={turnActivity ?? 'unread'} tooltip /> : null;
  const toggleSubsessions = () => toggleParent(expansionKey);
  const treeChevron = hasChildren && !isTwoLineRow
    ? <SessionTreeChevron expanded={isExpanded} onToggle={toggleSubsessions} />
    : null;
  const leadToggle = isTwoLineRow && hasChildren
    ? <SessionLeadToggle expanded={isExpanded} alwaysShowActions={alwaysShowActions} onToggle={toggleSubsessions} />
    : null;
  const leadIconClassName = alwaysShowActions ? 'opacity-0' : 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0';
  const treeSlot = isTwoLineRow ? null : treeChevron ?? <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />;

  const streamingIndicator = isZombie
    ? <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
    : null;

  // The recap of the last turn, for the whole-row tooltip, under the same
  // freshness rule the chat uses.
  const currentRecap = sessionRecapEnabled && !isStreaming
    ? getCurrentSessionAssist(session)?.recap || null
    : null;
  const rowBadges = (hasPendingPermission || hasPendingForm)
    ? <PendingRequestBadges hasPermission={hasPendingPermission} hasForm={hasPendingForm} />
    : null;
  const timelinePrBadge = isTimelineRow && primaryRef ? (
    <SessionRowPrBadge
      primaryRef={primaryRef}
      refLines={refLines}
      moreRefCount={moreRefCount}
      isOneLineTimelineRow={isOneLineTimelineRow}
      trackerDirectory={trackerDirectory}
    />
  ) : null;

  // A mark opens its extension's panel on this row's session, selecting it
  // first; an extension without a panel opens the mark's link where the user
  // is, as the PR badge opens its page, and selects nothing.
  const openGuestMark = (mark: RowGuestMark) => {
    if (!mark.panel) {
      if (mark.url) void openGuestUrl(mark.url, resolveEffectiveDirectory() ?? null, true);
      return;
    }
    handleSessionSelect(session.id, sessionDirectory);
    openGuestSurface({ mode: pluginModeFromId(mark.guestId), directory: sessionDirectory, supported: true });
  };

  // Every row shares the timeline row body: grouped and Chats rows use its
  // one-line form, with the session's live state and time on the right.
  const rowBody = (
    <SessionTimelineRowBody
      compact={!isTwoLineRow}
      leadToggle={leadToggle}
      leadIconClassName={leadToggle ? leadIconClassName : undefined}
      leadMaskClassName={leadToggle && !alwaysShowActions ? 'group-hover:oc-lead-mask group-has-[:focus-visible]:oc-lead-mask' : undefined}
      project={timelineProject}
      projectLabel={tooltipProjectLabel}
      title={sessionTitle}
      // A finished turn nobody has seen and a request waiting on the user
      // read like an unread mail; a running turn at full strength; the rest
      // recede.
      // A repeat row has no fill, so its title takes the sidebar's full text
      // colour.
      titleClassName={isRowSelected || (isActive && !repeat)
        ? 'text-interactive-selection-foreground'
        : isActive
          ? 'text-foreground'
          : showUnreadStatus || hasPendingPermission || hasPendingForm
          ? 'font-semibold text-foreground'
          : isStreaming ? 'text-foreground' : 'oc-title-rest'}
      branchLabel={tooltipBranchLabel}
      spaceMark={branchInSpace ? t('sessions.sidebar.group.space') : null}
      statusDot={liveStateMark}
      // Only a row that shows a pin gives up width for it: reserving the slot
      // on every project row cut their titles 20px short of the other lists'.
      pinnedMarker={isPinnedSession && !isSessionActionPending && !hidePinnedMarker ? <PinnedMark /> : null}
      // No date (rows go by recency); a turn's duration shows while it runs and until it is read.
      timeSlot={showActivityDuration && !waitingOnUser
        ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro" />
        : null}
      // Project rows leave the action indicator to their worktree header.
      directoryIndicator={!archivedBucket && sessionDirectory && renderContext !== 'project' ? <DirectoryActionIndicator directory={sessionDirectory} /> : null}
      prBadge={timelinePrBadge}
      zombieIndicator={isTimelineRow ? streamingIndicator : null}
      goal={goalMark}
      marks={guestMarks.length > 0 ? <GuestRowMarks marks={guestMarks} onOpen={openGuestMark} /> : null}
      badges={withOperatorChildrenCount(rowBadges, node.children)}
      doneHint={showDoneHint ? <DoneHintMark /> : null}
      // Grouped rows reserve room for permanent actions on their button.
      metaPaddingClass={isTimelineRow && alwaysShowActions
        ? (showQuickArchiveAction ? 'pe-13' : 'pe-7')
        : undefined}
      hideMetaOnHoverClass={alwaysShowActions && !isVSCode ? '' : actionLayout.coveredMetaFadeClass}
      actionsReserveClass={actionLayout.actionsReserveClass}
      actionsMaskClass={actionLayout.actionsMaskClass}
    />
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} dragKey={dragKey ?? sessionRowKey} ownerKey={folderOwnerKey ?? selectionScopeKey} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle} archivedBucket={archivedBucket}>
        <ContextMenuRoot open={isContextMenuOpen} onOpenChange={menus.handleContextMenuOpenChange} onOpenChangeComplete={menus.handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
            onKeyDown={openContextMenuFromKeyboard}
            render={
              <div
                data-session-row={session.id}
                data-session-row-box=""
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                aria-current={isActive ? 'page' : undefined}
                onClick={interactions.handleRowBackgroundClick}
                // The file tree geometry: 12px per level from an 8px edge,
                // then the slot and a 6px gap; a two-line row has no slot.
                style={{ paddingInlineStart: isTwoLineRow ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-md pe-2.5',
                  !isTwoLineRow && 'gap-1.5',
                  // A one-line row is a little shorter than a two-line one's
                  // padding: the list reads denser without the rows touching.
                  isTwoLineRow ? 'py-1.5' : 'py-[5px]',
                  // A repeat of the current session takes no fill: only its
                  // title at full strength marks it, so the sidebar shows one
                  // selected row, the first from the top.
                  !(isRowSelected || (isActive && !repeat)) && 'hover:bg-interactive-hover/60',
                  (isRowSelected || (isActive && !repeat)) && 'oc-selected text-interactive-selection-foreground',
                  isRowSelected && 'ring-1 ring-inset ring-border',
                )}
              />
            }
          >
          {treeSlot}
          <div className="flex min-w-0 flex-1 items-center">
            <Tooltip actionsRef={rowTooltip.actionsRef} onOpenChange={rowTooltip.onOpenChange}>
              {/* Rows without a tooltip keep the trigger inert: an open
                  but empty row tooltip would block the marks' own. It
                  closes as soon as the pointer leaves the row; a pointer
                  heading for its links still reaches them, as the popup
                  stays open along the way. */}
              <TooltipTrigger asChild closeDelay={0} disabled={isVSCode}>
                {/* A button by role only: the body holds the PR badge, a
                    real button, and HTML does not nest buttons. */}
                <div
                  role="button"
                  tabIndex={0}
                  data-session-row-main=""
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                  aria-pressed={selectionModeEnabled ? isRowSelected : undefined}
                  onPointerDown={interactions.handleRowPointerDown}
                  onPointerUp={interactions.handleRowPointerEnd}
                  onPointerCancel={interactions.handleRowPointerEnd}
                  onPointerEnter={interactions.handleRowPointerEnter}
                  onPointerLeave={interactions.handleRowHoverEnd}
                  onFocus={interactions.handleRowFocus}
                  onBlur={interactions.handleRowHoverEnd}
                  onMouseDown={interactions.handleRowMouseDown}
                  onClick={(event) => interactions.handleRowSelect(event)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    handleSessionDoubleClick(session.id, sessionTitle);
                  }}
                  className={cn(
                    'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground select-none',
                    interactions.isTouchPressed && 'bg-interactive-hover/70',
                    // Hover-revealed actions overlay the body, which keeps
                    // its width; only permanent actions take room.
                    isTimelineRow || !alwaysShowActions
                      ? undefined
                      : (isVSCode ? vscodeAlwaysActionPaddingClass : alwaysActionPaddingClass),
                  )}
                >
                  {rowBody}
                </div>
              </TooltipTrigger>
              {/* VS Code already shows project context via workspace headers, so
                  the per-row metadata tooltip is redundant noise there. */}
              {!isVSCode ? (
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-start">
                  <SessionRowTooltipBody
                    sessionTitle={sessionTitle}
                    updatedLabel={sessionUpdatedLabel}
                    compactUpdatedLabel={sessionCompactUpdatedLabel}
                    projectLabel={tooltipProjectLabel}
                    branchLabel={tooltipBranchLabel}
                    branchInSpace={branchInSpace}
                    branchPrIconColor={branchPrIconColor}
                    refLines={refLines}
                    trackerDirectory={trackerDirectory}
                    guestMarks={guestMarks}
                    recap={currentRecap}
                  />
                </TooltipContent>
              ) : null}
            </Tooltip>
          </div>

          {streamingIndicator && !mobileVariant && !isTimelineRow ? (
            <div className="absolute inset-e-1 top-1/2 -translate-y-1/2 z-10">
              {streamingIndicator}
            </div>
          ) : null}

          <SessionRowActions
            layout={actionLayout}
            session={session}
            sessionTitle={sessionTitle}
            archivedBucket={archivedBucket}
            isCurrentSession={isCurrentSession}
            isTimelineRow={isTimelineRow}
            isOneLineTimelineRow={isOneLineTimelineRow}
            alwaysShowActions={alwaysShowActions}
            isVSCode={isVSCode}
            isInWork={isInWork}
            toggleWork={toggleWork}
            setOpenSidebarMenuKey={setOpenSidebarMenuKey}
            handleDeleteSession={handleDeleteSession}
            isMenuOpen={menus.isMenuOpen}
            isSessionMenuOpen={isSessionMenuOpen}
            onMenuOpenChange={menus.handleMenuOpenChange}
            onMenuOpenChangeComplete={menus.handleMenuOpenChangeComplete}
            menuContent={menus.sessionMenuContent}
          />
          </ContextMenu.Trigger>
          {menus.contextMenuContent}
        </ContextMenuRoot>
      </DraggableSessionRow>
      {hasChildren && isExpanded ? children : null}
      {menus.dialogs}
    </React.Fragment>
  );
}

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
