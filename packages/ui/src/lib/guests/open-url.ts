import { isDesktopShell } from '@/lib/desktop';
import { isLoopbackHttpUrl, openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';

type GuestUrlTarget = 'browser-panel' | 'system';

type GuestUrlContext = {
  panelAvailable: boolean;
  directory: string | null;
  linksInPanel: boolean;
};

export const guestUrlTarget = (url: string, { panelAvailable, directory, linksInPanel }: GuestUrlContext): GuestUrlTarget => (
  panelAvailable && directory && (linksInPanel || isLoopbackHttpUrl(url)) ? 'browser-panel' : 'system'
);

export const openGuestUrl = async (url: string, directory: string | null, supported: boolean): Promise<boolean> => {
  const { openLinksInBrowserPanel, openContextPreview } = useUIStore.getState();
  const target = guestUrlTarget(url, {
    panelAvailable: supported && isDesktopShell(),
    directory,
    linksInPanel: openLinksInBrowserPanel,
  });
  if (target === 'browser-panel' && directory) {
    openContextPreview(directory, url);
    return true;
  }
  return openExternalUrl(url);
};
