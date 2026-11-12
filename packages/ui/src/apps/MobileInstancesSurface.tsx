import React from 'react';

import { MobileConnectionsView } from './MobileConnectionsView';

export const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => (
  <MobileConnectionsView mode="instances" onConnected={onConnect} onActiveConnectionDeleted={onActiveConnectionDeleted} />
);
