import React from 'react';

import { RemoteBrowserPane } from '@/components/browser/RemoteBrowserPane';

import {
  readMobileBrowserSelection,
  saveMobileBrowserSelection,
  type MobileBrowserScope,
} from './mobileBrowserSelection';

const ActiveMobileBrowserSurface: React.FC<{ scope: MobileBrowserScope }> = ({ scope }) => {
  // Restored IDs are attachment hints. The server still decides whether this
  // session and target exist; stale hints show the viewer's recovery state.
  const [selection] = React.useState(() => readMobileBrowserSelection(scope));
  const { runtimeKey, directory } = scope;
  const rememberSelection = React.useCallback((sessionId: string, serverTargetId: string) => {
    saveMobileBrowserSelection({ runtimeKey, directory }, { sessionId, serverTargetId });
  }, [runtimeKey, directory]);

  return (
    <div className="relative h-full">
      <RemoteBrowserPane
        directory={directory}
        sessionId={selection?.sessionId}
        serverTargetId={selection?.serverTargetId}
        onSelectRemoteTab={rememberSelection}
      />
    </div>
  );
};

export const MobileBrowserSurface: React.FC<{
  scope: MobileBrowserScope;
  active: boolean;
}> = ({ scope, active }) => active ? (
  <ActiveMobileBrowserSurface key={JSON.stringify([scope.runtimeKey, scope.directory])} scope={scope} />
) : null;
