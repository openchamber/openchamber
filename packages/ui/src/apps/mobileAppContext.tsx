/* eslint-disable react-refresh/only-export-components */
import React from 'react';

export type MobileAppActions = {
  /** Open the Changes surface as a modal and (optionally) navigate it to a specific diff. */
  openChanges: (options?: { diffPath?: string | null }) => void;
  /** Open the Files surface as a modal. */
  openFiles: () => void;
  /** Open the Settings surface as a modal. */
  openSettings: () => void;
};

const DedicatedMobileAppContext = React.createContext<MobileAppActions | null>(null);

export const DedicatedMobileAppProvider: React.FC<{
  actions: MobileAppActions;
  children: React.ReactNode;
}> = ({ actions, children }) => (
  <DedicatedMobileAppContext.Provider value={actions}>{children}</DedicatedMobileAppContext.Provider>
);

/**
 * Returns true when the surrounding tree is the dedicated MobileApp root
 * (Capacitor or hosted /mobile.html), as opposed to the desktop responsive
 * mobile path. Use this to suppress UI that exists only to bridge the
 * desktop sidebar/layout into mobile, since the dedicated mobile root has
 * its own native-feeling navigation and no sidebars to bridge into.
 */
export const useIsDedicatedMobileApp = (): boolean => React.useContext(DedicatedMobileAppContext) !== null;

/**
 * Returns the dedicated mobile app's surface-opening actions, or null when
 * not inside the dedicated mobile root. Components living in shared chat /
 * input code can use this to route navigation to mobile-native surfaces
 * (e.g. open the Changes diff for a file from PendingChangesBar) instead of
 * desktop sidebars.
 */
export const useMobileAppActions = (): MobileAppActions | null => React.useContext(DedicatedMobileAppContext);
