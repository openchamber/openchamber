import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { closeBrowserPopout, openBrowserPopout } from '@/lib/browser/popout';
import { browserPopoutKey, useBrowserPopoutStore } from '@/stores/useBrowserPopoutStore';

interface BrowserDetachedPlaceholderProps {
  directory: string;
  tabID: string;
  url: string;
}

/**
 * Shown in the context panel while the browser tab is detached into a separate
 * window. "Bring back" docks the pane again (and closes the pop-out window);
 * "Focus window" raises the existing pop-out.
 */
export const BrowserDetachedPlaceholder: React.FC<BrowserDetachedPlaceholderProps> = ({ directory, tabID, url }) => {
  const { t } = useI18n();
  const setDetached = useBrowserPopoutStore((state) => state.setDetached);
  const key = browserPopoutKey(directory, tabID);

  const bringBack = React.useCallback(() => {
    setDetached(key, false);
    closeBrowserPopout({ directory, tabID });
  }, [directory, tabID, key, setDetached]);

  const focusWindow = React.useCallback(() => {
    void openBrowserPopout({ url, directory, tabID });
  }, [url, directory, tabID]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background p-6 text-center">
      <OpenChamberLogo width={120} height={120} className="opacity-15" />
      <div className="flex items-center gap-2 typography-ui-header text-muted-foreground">
        <Icon name="picture-in-picture-2" className="h-4 w-4" />
        {t('contextPanel.browser.poppedOut.title')}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={bringBack} className="!font-normal">
          <Icon name="corner-down-left" className="mr-1.5 h-3.5 w-3.5" />
          {t('contextPanel.browser.poppedOut.bringBack')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={focusWindow} className="!font-normal">
          {t('contextPanel.browser.poppedOut.focus')}
        </Button>
      </div>
    </div>
  );
};
