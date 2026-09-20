import React from 'react';

type SessionRowMenuStateArgs = {
  menuInstanceKey: string;
  /** Null for rows rendered without an occurrence key; their context menu keeps local state. */
  contextMenuInstanceKey: string | null;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  /** True when a menu item deferred work (inline rename) until the close transition completes. */
  hasDeferredCloseWork: () => boolean;
  /** Runs once the menu has fully closed, before the row releases its open-menu key. */
  onCloseComplete: () => void;
};

/**
 * Owns the open state of a session row's overflow and context menus.
 *
 * The shared `openSidebarMenuKey` also pins the row occurrence in the
 * virtualizer, so it must stay set until close completion when a menu item
 * deferred work to `onOpenChangeComplete`. The controlled `open` prop cannot
 * follow that key directly: a close request that leaves it set keeps the menu
 * open, `onOpenChangeComplete(false)` never fires, and the deferred rename
 * never starts. A local close request hides the menu while the key stays
 * pinned until completion.
 */
export const useSessionRowMenuState = ({
  menuInstanceKey,
  contextMenuInstanceKey,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  hasDeferredCloseWork,
  onCloseComplete,
}: SessionRowMenuStateArgs) => {
  const [legacyContextMenuOpen, setLegacyContextMenuOpen] = React.useState(false);
  const [closeRequested, setCloseRequested] = React.useState(false);

  const isMenuOpen = openSidebarMenuKey === menuInstanceKey && !closeRequested;
  const isContextMenuOpen = contextMenuInstanceKey
    ? openSidebarMenuKey === contextMenuInstanceKey && !closeRequested
    : legacyContextMenuOpen;

  const requestClose = (instanceKey: string) => {
    if (openSidebarMenuKey !== instanceKey) return;
    if (hasDeferredCloseWork()) {
      setCloseRequested(true);
      return;
    }
    setOpenSidebarMenuKey(null);
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (open) {
      setLegacyContextMenuOpen(false);
      setCloseRequested(false);
      setOpenSidebarMenuKey(menuInstanceKey);
      return;
    }
    requestClose(menuInstanceKey);
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    if (!contextMenuInstanceKey) {
      setLegacyContextMenuOpen(open);
      return;
    }
    if (open) {
      setCloseRequested(false);
      setOpenSidebarMenuKey(contextMenuInstanceKey);
      return;
    }
    requestClose(contextMenuInstanceKey);
  };

  const handleMenuOpenChangeComplete = (open: boolean) => {
    if (open) return;
    onCloseComplete();
    setCloseRequested(false);
    if (openSidebarMenuKey === menuInstanceKey || openSidebarMenuKey === contextMenuInstanceKey) {
      setOpenSidebarMenuKey(null);
    }
  };

  const toggleMenu = () => {
    setCloseRequested(false);
    setOpenSidebarMenuKey(isMenuOpen ? null : menuInstanceKey);
  };

  return {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
    toggleMenu,
  };
};
