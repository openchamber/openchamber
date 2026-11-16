import React from 'react';
import { toggleSessionRead } from '@/components/session/sessionReadActions';
import { openSessionInSidePanel } from '@/components/session/sessionSidePanel';
import { useI18n } from '@/lib/i18n';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { usePrefetchSessionMessages } from '@/sync/use-sync';
import { useSessionHoverPrefetch } from '../list/useSessionPrefetch';
import type { SessionNode } from '../types';
import { holdSessionRowPosition } from './holdSessionRowPosition';
import { isRowBoxClick } from './rowBoxClick';
import { collectNodeDescendantIds } from './sessionNodeItemUtils';
import { useSessionRowOrderRegistry } from './sessionRowOrder';

type SessionRowInteractionsInput = {
  node: SessionNode;
  sessionDirectory: string | null;
  sessionTitle: string;
  sessionRowKey: string;
  selectionScopeKey: string | null;
  archivedBucket: boolean;
  isActive: boolean;
  isVSCode: boolean;
  mobileVariant: boolean;
  needsAttention: boolean;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
};

export function useSessionRowInteractions({
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
}: SessionRowInteractionsInput) {
  const { t } = useI18n();
  const session = node.session;
  const [isTouchPressed, setIsTouchPressed] = React.useState(false);
  const prefetchSessionMessages = usePrefetchSessionMessages();
  const prefetchOnPressDisabled = isVSCode;
  const hoverPrefetch = useSessionHoverPrefetch();

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);
  const sessionRowOrderRegistry = useSessionRowOrderRegistry();

  const handleOpenInSidePanel = () => {
    if (!sessionDirectory) return;
    openSessionInSidePanel(session.id, sessionDirectory, sessionTitle);
  };

  const handleRowSelect = (event?: React.MouseEvent<HTMLElement>) => {
    if (event?.ctrlKey && !selectionModeEnabled) return;
    if (selectionModeEnabled) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const registeredEntries = sessionRowOrderRegistry?.getEntries();
        const entries = registeredEntries ?? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          .map((element) => element.getAttribute('data-session-row'))
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id, rowKey: id, scopeKey: selectionScopeKey, archived: archivedBucket }));
        const currentAnchor = registeredEntries
          ? useSessionMultiSelectStore.getState().anchorRowKey
          : useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, sessionRowKey, entries, sessionRowOrderRegistry?.getDescendantIds() ?? [], selectionScopeKey, descendantsById);
        return;
      }
      toggleRowSelected(session.id, selectionScopeKey, collectNodeDescendantIds(node), sessionRowKey);
      return;
    }
    if (event?.shiftKey && !isVSCode && sessionDirectory) {
      handleOpenInSidePanel();
      return;
    }
    if (event?.altKey) {
      toggleSessionRead(session.id, needsAttention, t);
      return;
    }
    if (event?.currentTarget) holdSessionRowPosition(event.currentTarget);
    handleSessionSelect(session.id, sessionDirectory);
  };

  const handleRowBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isRowBoxClick(event)) handleRowSelect(event);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 0 && event.shiftKey && !selectionModeEnabled) {
      event.preventDefault();
    }
  };
  const handleRowPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(true);
    }
    if (
      event.button === 0
      && !isActive
      && !selectionModeEnabled
      && !prefetchOnPressDisabled
      && sessionDirectory
      && !getSyncSessionMaterializationStatus(session.id, sessionDirectory).renderable
    ) {
      void prefetchSessionMessages({ directory: sessionDirectory, sessionID: session.id }).catch(() => undefined);
    }
  };
  const hoverPrefetchTarget = !isActive && !selectionModeEnabled && sessionDirectory
    ? { id: session.id, directory: sessionDirectory }
    : null;
  const handleRowPointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || !hoverPrefetchTarget) return;
    hoverPrefetch?.schedule(hoverPrefetchTarget);
  };
  const handleRowFocus = () => {
    if (hoverPrefetchTarget) hoverPrefetch?.schedule(hoverPrefetchTarget);
  };
  const handleRowHoverEnd = () => {
    if (hoverPrefetchTarget) hoverPrefetch?.cancel(hoverPrefetchTarget);
  };
  const handleRowPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(false);
    }
  };

  return {
    isRowSelected,
    selectionModeEnabled,
    isTouchPressed,
    handleRowSelect,
    handleRowBackgroundClick,
    handleRowMouseDown,
    handleRowPointerDown,
    handleRowPointerEnter,
    handleRowFocus,
    handleRowHoverEnd,
    handleRowPointerEnd,
  };
}
