/* oxlint-disable react/only-export-components */
import React from 'react';
import type { ProjectRef } from '@/lib/projectContextApi';

export type MobileAppActions = {
  openChanges: (options?: { diffPath?: string | null; staged?: boolean; scope?: 'turn'; turnId?: string; sessionId?: string | null; directory?: string | null }) => void;
  openFiles: () => void;
  openSourceBoard: () => void;
  openPlan: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  openReceivedPage: (page: { receivedId: string; title: string }) => void;
};

const DedicatedMobileAppContext = React.createContext<MobileAppActions | null>(null);

export const DedicatedMobileAppProvider: React.FC<{
  actions: MobileAppActions;
  children: React.ReactNode;
}> = ({ actions, children }) => (
  <DedicatedMobileAppContext.Provider value={actions}>{children}</DedicatedMobileAppContext.Provider>
);

export const useMobileAppActions = (): MobileAppActions | null => React.useContext(DedicatedMobileAppContext);
