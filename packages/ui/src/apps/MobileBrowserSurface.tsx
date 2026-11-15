import React from 'react';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { previewFramesIsolated } from '@/lib/browser/mobileDevTunnel';
import { useI18n } from '@/lib/i18n';

/** The phone's display-only browser, scoped to the open chat's directory. */
export const MobileBrowserSurface: React.FC<{
  visible: boolean;
  registerBackHandler: (handler: (() => boolean) | null) => void;
}> = ({ visible, registerBackHandler }) => {
  const { t } = useI18n();
  const ownDirectory = useEffectiveDirectory();
  const draftSpace = useDraftSpaceTarget();
  const siteDirectory = panelContentDirectory(draftSpace, ownDirectory);
  const [isolated, setIsolated] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void previewFramesIsolated().then((value) => {
      if (!cancelled) setIsolated(value);
    });
    return () => { cancelled = true; };
  }, []);
  if (isolated === null) return null;
  if (!isolated) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center typography-micro text-muted-foreground">
        {t('contextPanel.browser.unsafeWebView')}
      </div>
    );
  }
  if (draftSpace?.kind === 'preparing') return <SpacePreparing />;
  return (
    <BrowserPane
      key={siteDirectory ?? ''}
      initialUrl=""
      directory={ownDirectory ?? ''}
      siteDirectory={siteDirectory ?? ''}
      tabID="mobile-preview"
      ownerSessionId={null}
      showHome
      registerBackHandler={registerBackHandler}
      visible={visible}
    />
  );
};
