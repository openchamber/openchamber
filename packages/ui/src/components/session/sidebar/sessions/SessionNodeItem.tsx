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
import { isLeadSession } from '@/lib/sessionLead';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { openGuestUrl } from '@/lib/guests/open-url';
import type { RowGuestMark } from '@/lib/guests/marks';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getSessionActivityTime } from '@/sync/session-ordering';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { findBlockingRequestTarget, openBlockingRequestTarget } from '@/sync/sync-context';
import type { BlockingRequestKind } from '@/sync/session-request-hooks';
import { DraggableSessionRow } from '../folders/sessionFolderDnd';
import { listedChildren } from '../listedChildren';
import { isPinnedZoneRowKey, sessionExpansionKey } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel, formatSessionDateLabel } from '../utils';
import { DirectoryActionIndicator } from './DirectoryActionIndicator';
import { GuestRowMarks } from './GuestRowMarks';
import { SessionLeadSlot, SessionLeadToggle, SessionTreeChevron } from './SessionRowChevrons';
import { SessionRowActions } from './SessionRowActions';
import { SessionRowPrBadge } from './SessionRowPrBadge';
import { SessionRowRename } from './SessionRowRename';
import { SessionRowTooltipBody } from './SessionRowTooltipBody';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { holdSessionRowPosition } from './holdSessionRowPosition';
import { selectBlockingBadgeSessions } from './sessionNodeItemUtils';
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
import { useLiveSessionNode } from './useLiveSessionNode';
import { useShowsOpenHiddenSession } from './useShowsOpenHiddenSession';

export type { SessionNodeItemProps } from './sessionNodeItemProps';

function SessionNodeItemComponent(props: SessionNodeItemProps): React.ReactNode {
  streamPerfCount('ui.sidebar_session_node.render');
  const { t } = useI18n();
  const {
    node: structuralNode,
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
  const node = useLiveSessionNode(structuralNode);
  const session = node.session;
  const { isOneLineTimelineRow, isTwoLineRow, isTimelineRow, isZoneRow } = resolveSessionRowLines(renderContext, detailed);
  const hidePinnedMarker = rowKey !== undefined && isPinnedZoneRowKey(rowKey);

  const {
    isCurrentSession,
    isActive,
    chatCovered,
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
  const showSubagentSessions = useSessionDisplayStore((state) => state.showSubagentSessions);
  const hasChildren = listedChildren(node, showSubagentSessions).length > 0;
  const isPinnedSession = isSessionPinned(pinnedSessionIds, sessionDirectory, session.id);
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
  } = useSessionRowLiveState({ node, sessionDirectory, isExpanded, showSubagentSessions, isActive, timelineBadgeSessionScopes });
  const showsOpenHiddenSession = useShowsOpenHiddenSession(node, isExpanded, showSubagentSessions, chatCovered);
  const { canTrackWork, pinBlocksWork, isInWork, showDoneHint, toggleWork } = useSessionRowWork({
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
    pinBlocksWork,
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
  const pendingBadgeCount = (hasPendingPermission ? 1 : 0) + (hasPendingForm ? 1 : 0);
  const badgesOpenRequests = !selectionModeEnabled;
  const badgesAtRowEnd = badgesOpenRequests && !isTwoLineRow && pendingBadgeCount > 0;
  const hoverRevealsActions = !alwaysShowActions || isVSCode;
  const vscodeRoomBesideBadges = isVSCode && alwaysShowActions && badgesAtRowEnd;
  const actionLayout = resolveSessionRowActionLayout({
    isVSCode,
    alwaysShowActions,
    archivedBucket,
    mobileVariant,
    canTrackWork,
    isTimelineRow,
    isOneLineTimelineRow,
    isSessionMenuOpen,
    endBadgeCount: badgesAtRowEnd && hoverRevealsActions ? (pendingBadgeCount === 2 ? 2 : 1) : 0,
  });
  const openPendingRequest = (kind: BlockingRequestKind, badge: HTMLElement) => {
    const badgeSessions = timelineBadgeSessionScopes
      ? timelineBadgeSessionScopes.flatMap(({ directory, sessionIDs }) => sessionIDs.map((sessionID) => ({ sessionID, directory })))
      : selectBlockingBadgeSessions(node, isExpanded, sessionDirectory, showSubagentSessions);
    const target = findBlockingRequestTarget(badgeSessions, kind);
    if (!target) return;
    holdSessionRowPosition(badge);
    openBlockingRequestTarget(target, handleSessionSelect);
  };
  const isHighlighted = isActive || showsOpenHiddenSession;
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);

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
        isActive={isActive || showsOpenHiddenSession}
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
  const isLead = isLeadSession(session);
  const treeSlot = isTwoLineRow
    ? null
    : isLead
      ? <SessionLeadSlot chevron={treeChevron} alwaysShowActions={alwaysShowActions} />
      : treeChevron ?? <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />;

  const streamingIndicator = isZombie
    ? <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
    : null;

  const currentRecap = sessionRecapEnabled && !isStreaming
    ? getCurrentSessionAssist(session)?.recap || null
    : null;
  const rowBadges = pendingBadgeCount > 0
    ? <PendingRequestBadges hasPermission={hasPendingPermission} hasForm={hasPendingForm} onOpen={badgesOpenRequests ? openPendingRequest : undefined} />
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

  const openGuestMark = (mark: RowGuestMark) => {
    if (!mark.panel) {
      if (mark.url) void openGuestUrl(mark.url, resolveEffectiveDirectory() ?? null, true);
      return;
    }
    handleSessionSelect(session.id, sessionDirectory);
    openGuestSurface({ mode: pluginModeFromId(mark.guestId), directory: sessionDirectory, supported: true });
  };

  const rowBody = (
    <SessionTimelineRowBody
      compact={!isTwoLineRow}
      leadToggle={leadToggle}
      leadIconClassName={leadToggle ? leadIconClassName : undefined}
      leadMaskClassName={leadToggle && !alwaysShowActions ? 'group-hover:oc-lead-mask group-has-[:focus-visible]:oc-lead-mask' : undefined}
      project={timelineProject}
      projectLabel={tooltipProjectLabel}
      title={sessionTitle}
      titleClassName={isRowSelected || (isHighlighted && !repeat)
        ? 'text-interactive-selection-foreground'
        : isHighlighted
          ? 'text-foreground'
          : showUnreadStatus || hasPendingPermission || hasPendingForm
          ? 'font-semibold text-foreground'
          : isStreaming ? 'text-foreground' : 'oc-title-rest'}
      branchLabel={tooltipBranchLabel}
      spaceMark={branchInSpace ? t('sessions.sidebar.group.space') : null}
      statusDot={liveStateMark}
      pinnedMarker={isPinnedSession && !isSessionActionPending && !hidePinnedMarker ? <PinnedMark /> : null}
      timeSlot={showActivityDuration && !waitingOnUser
        ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro" />
        : null}
      directoryIndicator={!archivedBucket && sessionDirectory && renderContext !== 'project' ? <DirectoryActionIndicator directory={sessionDirectory} /> : null}
      prBadge={timelinePrBadge}
      zombieIndicator={isTimelineRow ? streamingIndicator : null}
      goal={goalMark}
      marks={guestMarks.length > 0 || (isTwoLineRow && isLead) ? <>
        {isTwoLineRow && isLead ? <SessionLeadSlot chevron={null} alwaysShowActions={alwaysShowActions} /> : null}
        {guestMarks.length > 0 ? <GuestRowMarks marks={guestMarks} onOpen={openGuestMark} /> : null}
      </> : null}
      badges={badgesAtRowEnd ? null : rowBadges}
      endBadges={badgesAtRowEnd ? rowBadges : null}
      doneHint={showDoneHint ? <DoneHintMark /> : null}
      metaActionsRoomClass={actionLayout.endBadgeActionsRoomClass}
      metaPaddingClass={isTimelineRow && alwaysShowActions && !vscodeRoomBesideBadges
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
                aria-current={isActive ? 'page' : showsOpenHiddenSession ? 'true' : undefined}
                onClick={interactions.handleRowBackgroundClick}
                style={{ paddingInlineStart: isTwoLineRow ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-md pe-2.5',
                  !isTwoLineRow && 'gap-1.5',
                  isTwoLineRow ? 'py-1.5' : 'py-[5px]',
                  !(isRowSelected || (isHighlighted && !repeat)) && 'hover:bg-interactive-hover/60',
                  (isRowSelected || (isHighlighted && !repeat)) && 'oc-selected text-interactive-selection-foreground',
                  isRowSelected && 'ring-1 ring-inset ring-border',
                )}
              />
            }
          >
          {treeSlot}
          <div className="flex min-w-0 flex-1 items-center">
            <Tooltip actionsRef={rowTooltip.actionsRef} onOpenChange={rowTooltip.onOpenChange}>
              <TooltipTrigger asChild closeDelay={0} disabled={isVSCode}>
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
                    isTimelineRow || !alwaysShowActions
                      ? undefined
                      : (isVSCode ? (vscodeRoomBesideBadges ? undefined : vscodeAlwaysActionPaddingClass) : alwaysActionPaddingClass),
                  )}
                >
                  {rowBody}
                </div>
              </TooltipTrigger>
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
