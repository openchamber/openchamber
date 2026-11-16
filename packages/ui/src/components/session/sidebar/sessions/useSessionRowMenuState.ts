import React from 'react';

type SessionRowMenuStateArgs = {
  menuInstanceKey: string;
  contextMenuInstanceKey: string | null;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  hasDeferredCloseWork: () => boolean;
  onCloseComplete: () => void;
};

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

  return {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
  };
};
