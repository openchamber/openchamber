import React from "react";
import { createPortal } from "react-dom";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSessionRevertMessageID, useDirectorySync } from "@/sync/sync-context";
import type { State as SyncState } from "@/sync/types";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon/Icon";
import { RevertPopover } from "./RevertPopover";

interface RevertIndicatorProps {
  sessionId: string;
}

/**
 * Compact revert indicator for the StatusRow area.
 * Styled to match the todo trigger button pattern:
 *   [icon] [label] [count] [↑/↓]
 *
 * Returns null when not reverted.
 *
 * Reads from session-ui-store (activeRevertMessageID) first, then falls back
 * to sync store (session.revert.messageID) so the indicator survives refresh.
 */
export const RevertIndicator: React.FC<RevertIndicatorProps> = ({ sessionId }) => {
  const { t } = useI18n();
  // UI store: set by handleSlashUndo/revertToMessage, cleared by clearRevertHistory
  const uiRevertMessageID = useSessionUIStore((s) => s.activeRevertMessageIDs.get(sessionId));
  // Sync store: always reflects server state (survives refresh via SSE)
  const syncRevertMessageID = useSessionRevertMessageID(sessionId);

  // Track when UI store revert was explicitly cleared (user sent a new message)
  // so we can suppress the stale sync fallback immediately in the render,
  // not just in a subsequent effect (which causes a brief "已撤回" flash).
  const revertExplicitlyClearedRef = React.useRef(false);
  const lastSyncedRevertRef = React.useRef<string | undefined>(undefined);

  // Detect when UI store revert is cleared (user sent a new message or
  // unreverted) so we suppress the stale sync fallback. Set the ref
  // synchronously during render (not in an effect) so the revertMessageID
  // computation in the same render already sees the updated flag.
  if (!uiRevertMessageID && lastSyncedRevertRef.current) {
    revertExplicitlyClearedRef.current = true;
  }

  // Use UI store first (more responsive), fallback to sync store (survives refresh).
  // When the UI store was explicitly cleared (user sent a message), skip the sync
  // fallback entirely so the indicator disappears immediately instead of briefly
  // showing "已撤回" without a count while waiting for SSE to catch up.
  const revertMessageID = uiRevertMessageID
    ?? (revertExplicitlyClearedRef.current ? null : syncRevertMessageID)
    ?? null;
  const ensureRevertSnapshot = useSessionUIStore((s) => s.ensureRevertSnapshot);
  const handleSlashRedo = useSessionUIStore((s) => s.handleSlashRedo);
  const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
  const revertedMessagesCount = useSessionUIStore(
    React.useCallback(
      (state) => state.revertHistory.get(sessionId)?.revertedMessages.length ?? 0,
      [sessionId],
    ),
  );

  // Popover expand state (declared here so callbacks below can reference it)
  const [isExpanded, setIsExpanded] = React.useState(false);
  // isPanelLocked: disables all buttons during any async operation
  // isRestoreAllLoading: shows spinner specifically on "Restore All" button
  // restoringMessageId: message being reverted individually (for per-button spinner)
  const [isPanelLocked, setIsPanelLocked] = React.useState(false);
  const [isRestoreAllLoading, setIsRestoreAllLoading] = React.useState(false);
  const [restoringMessageId, setRestoringMessageId] = React.useState<string | null>(null);
  const anchorRef = React.useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = React.useState<{ bottom: number; left: number } | null>(null);
  const mountedRef = React.useRef(true);

  // Lock panel, await API, close popover on success, unlock on completion.
  // State lives here (not in RevertPopover) so it survives popover close/reopen.
  const handleRestoreAll = React.useCallback(async () => {
    setIsPanelLocked(true);
    setIsRestoreAllLoading(true);
    try {
      await handleSlashRedo(sessionId, { fullUnrevert: true });
      if (mountedRef.current) setIsExpanded(false);
    } catch {
      // API failed — keep popover open for retry
    } finally {
      setIsPanelLocked(false);
      setIsRestoreAllLoading(false);
    }
  }, [sessionId, handleSlashRedo]);

  const handleRevertToMessage = React.useCallback(async (messageId: string) => {
    setIsPanelLocked(true);
    setRestoringMessageId(messageId);
    try {
      await revertToMessage(sessionId, messageId);
      if (mountedRef.current) setIsExpanded(false);
    } catch {
      // API failed — keep popover open for retry
    } finally {
      setIsPanelLocked(false);
      setRestoringMessageId(null);
    }
  }, [sessionId, revertToMessage]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Sync UI store with server state on refresh: if sync store has a revert
  // point but UI store doesn't (page was refreshed), initialize the UI store
  // so the indicator and popover work correctly.
  // Uses a ref to skip setState when the value hasn't actually changed,
  // preventing unnecessary re-renders when sync store emits the same value.
  // Also tracks when the UI store was explicitly cleared (user sent a new message)
  // so we don't re-show the indicator from the stale sync fallback.
  React.useEffect(() => {
    if (syncRevertMessageID && lastSyncedRevertRef.current !== syncRevertMessageID) {
      // Sync store has a revert point — only propagate to UI store if
      // the user hasn't explicitly cleared it (e.g. by sending a new message)
      if (!revertExplicitlyClearedRef.current) {
        const uiState = useSessionUIStore.getState();
        if (!uiState.activeRevertMessageIDs.get(sessionId)) {
          const nextIds = new Map(uiState.activeRevertMessageIDs)
          nextIds.set(sessionId, syncRevertMessageID)
          useSessionUIStore.setState({ activeRevertMessageIDs: nextIds });
        }
      }
      lastSyncedRevertRef.current = syncRevertMessageID;
    }
    if (!syncRevertMessageID) {
      // Sync store confirmed revert is cleared — reset the flag so future
      // reverts (e.g. another undo) can propagate again
      revertExplicitlyClearedRef.current = false;
      lastSyncedRevertRef.current = undefined;
    }
  }, [syncRevertMessageID, sessionId]);

  // On first popover open after refresh, lazily re-snapshot reverted messages
  // because revertHistory lives in-memory and is lost on page reload.
  React.useEffect(() => {
    if (!isExpanded || revertedMessagesCount !== 0 || !revertMessageID) return;
    ensureRevertSnapshot(sessionId);
  }, [isExpanded, revertedMessagesCount, revertMessageID, sessionId, ensureRevertSnapshot]);

  // Compute popover position from anchor button
  React.useEffect(() => {
    if (!isExpanded || !anchorRef.current) {
      setPopoverPos(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    // Guard against unmount during effect
    if (mountedRef.current) {
      setPopoverPos({
        bottom: window.innerHeight - rect.top + 4, // 4px gap above the button
        left: rect.left,
      });
    }
  }, [isExpanded]);

  // Close popover on click outside
  React.useEffect(() => {
    if (!isExpanded) return;
    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if clicking inside the popover or the anchor button
      if (anchorRef.current?.contains(event.target as Node)) return;
      // Check if click is inside the portal popover
      const popoverEl = document.getElementById(`revert-popover-portal-${sessionId}`);
      if (popoverEl?.contains(event.target as Node)) return;
      if (mountedRef.current) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  // Subscribe to message count from sync store. Used for two purposes:
  //   (1) render guard — prevent showing indicator before messages load
  //   (2) effect trigger — rebuild revert snapshot when messages arrive
  const syncMessageCount = useDirectorySync(
    React.useCallback((s: SyncState) => s.message[sessionId]?.length ?? 0, [sessionId]),
  );

  // Rebuild the reverted-messages snapshot once both conditions are met:
  //  - a revert point exists (revertMessageID is set)
  //  - messages are available in the sync store (syncMessageCount > 0)
  // After refresh, syncRevertMessageID arrives first via SSE, then messages
  // arrive later. This effect fires on whichever condition is satisfied last,
  // so the count appears as soon as possible without a flash.
  React.useEffect(() => {
    if (syncMessageCount === 0 || !revertMessageID || revertedMessagesCount !== 0) return;
    ensureRevertSnapshot(sessionId);
  }, [syncMessageCount, revertMessageID, revertedMessagesCount, sessionId, ensureRevertSnapshot]);

  // Show only when session has a revert point AND messages are fully loaded
  if (!revertMessageID || syncMessageCount === 0) return null;

  return (
    <>
      {/* Trigger button — styled like todo trigger */}
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
        aria-label={t("chat.revertPopover.title")}
      >
        <span className="typography-ui-label">{t("chat.revertPopover.title")}</span>
        <span className="typography-meta flex items-center gap-1 tabular-nums" aria-hidden="true">
          {revertedMessagesCount > 0 && (
            <span className="flex items-center gap-0.5">
              {revertedMessagesCount}
            </span>
          )}
        </span>
        {isExpanded ? (
          <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        ) : (
          <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Popover rendered via portal to escape overflow clipping */}
      {isExpanded && popoverPos && createPortal(
        <div
          id={`revert-popover-portal-${sessionId}`}
          style={{
            position: "fixed",
            bottom: popoverPos.bottom,
            left: popoverPos.left,
            zIndex: 50,
          }}
        >
          <RevertPopover
            sessionId={sessionId}
            isPanelLocked={isPanelLocked}
            isRestoreAllLoading={isRestoreAllLoading}
            restoringMessageId={restoringMessageId}
            onRestoreAll={handleRestoreAll}
            onRevertToMessage={handleRevertToMessage}
          />
        </div>,
        document.body,
      )}
    </>
  );
};
