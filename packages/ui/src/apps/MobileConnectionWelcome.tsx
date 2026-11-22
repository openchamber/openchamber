import React from 'react';

import { MobileConnectionsView, type MobileConnectionNotice } from './MobileConnectionsView';

export type { MobileConnectionNotice };

export const MobileConnectionWelcome: React.FC<{
  onConnected: () => void;
  notice?: MobileConnectionNotice | null;
}> = ({ onConnected, notice = null }) => (
  <MobileConnectionsView mode="welcome" onConnected={onConnected} notice={notice} />
);
