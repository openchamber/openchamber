import React from 'react';

import type { MobileChangesInitialDiff } from '@/hooks/useMobileChangesNavigation';
import { closeAllBackLayers } from '@/lib/mobileBackLayers';
import type { MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { useUIStore } from '@/stores/useUIStore';

import { useDeepLinkHandlers } from './deepLinkNavigation';

type SettingsPage = Parameters<ReturnType<typeof useUIStore.getState>['setSettingsPage']>[0];

type MobileShell = {
  isTabletLayout: boolean;
  setSidebarOpen: (open: boolean) => void;
  setSessionsSheetOpen: (open: boolean) => void;
  setWorkspaceTab: (tab: MobileWorkspaceTab) => void;
  setWorkspaceOpen: (open: boolean) => void;
  setOpenReceivedPage: (page: null) => void;
  openSurface: (surface: 'instances' | 'update') => void;
  openFilesSurface: () => void;
  openChangesSurface: (diff: MobileChangesInitialDiff | null) => void;
  openSettingsSurface: (stage: 'nav' | 'page-content') => void;
  closeSurface: () => void;
  closeGuestPage: () => void;
  closeWorkspace: () => void;
};

export function useMobileDeepLinkHandlers({
  isTabletLayout, setSidebarOpen, setSessionsSheetOpen, setWorkspaceTab, setWorkspaceOpen, setOpenReceivedPage,
  openSurface, openFilesSurface, openChangesSurface, openSettingsSurface, closeSurface, closeGuestPage, closeWorkspace,
}: MobileShell): void {
  const handlers = React.useMemo(
    () => ({
      showChat: () => {
        closeAllBackLayers();
        setOpenReceivedPage(null);
        closeSurface();
        closeGuestPage();
        closeWorkspace();
        setSessionsSheetOpen(false);
        useUIStore.getState().setRunOverviewKey(null);
      },
      openSessions: () => {
        if (isTabletLayout) setSidebarOpen(true);
        else setSessionsSheetOpen(true);
      },
      openView: (target: 'files' | 'mcp' | 'instances' | 'update') => {
        if (target === 'files') {
          openFilesSurface();
          return;
        }
        if (target === 'mcp') {
          setWorkspaceTab('status');
          setWorkspaceOpen(true);
          return;
        }
        openSurface(target);
      },
      openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => {
        openChangesSurface(path ? { path, staged: staged === true } : null);
      },
      openSettings: (section?: string) => {
        if (section) useUIStore.getState().setSettingsPage(section as SettingsPage);
        openSettingsSurface(section ? 'page-content' : 'nav');
      },
    }),
    [
      closeGuestPage, closeSurface, closeWorkspace, isTabletLayout, openChangesSurface, openFilesSurface, openSettingsSurface,
      openSurface, setOpenReceivedPage, setSessionsSheetOpen, setSidebarOpen, setWorkspaceOpen, setWorkspaceTab,
    ],
  );
  useDeepLinkHandlers(handlers);
}
