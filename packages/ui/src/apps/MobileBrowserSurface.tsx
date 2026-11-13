import React from 'react';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';

/** The phone's display-only browser, scoped to the open chat's directory. */
export const MobileBrowserSurface: React.FC<{ visible: boolean }> = ({ visible }) => {
  const ownDirectory = useEffectiveDirectory();
  const draftSpace = useDraftSpaceTarget();
  const siteDirectory = panelContentDirectory(draftSpace, ownDirectory);
  if (draftSpace?.kind === 'preparing') return <SpacePreparing />;
  return (
    <BrowserPane
      key={siteDirectory ?? ''}
      initialUrl=""
      directory={ownDirectory ?? ''}
      siteDirectory={siteDirectory ?? ''}
      tabID="mobile-preview"
      ownerSessionId={null}
      visible={visible}
    />
  );
};
