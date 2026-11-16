import React from 'react';

import { MobileConnectionsView, type MobileConnectionNotice } from './MobileConnectionsView';

export type { MobileConnectionNotice };

export const MobileConnectionWelcome: React.FC<{
  onConnected: () => void;
  /** Why the user landed here (failed cold-launch auto-connect): shown as a banner. */
  notice?: MobileConnectionNotice | null;
}> = ({ onConnected, notice = null }) => (
  <MobileConnectionsView mode="welcome" onConnected={onConnected} notice={notice} />
);
