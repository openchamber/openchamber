import React from 'react';

import { takePendingDesktopExtensionInstalls } from '@/lib/desktop';
import { requestGuestInstall } from '@/lib/guests/install-request';

const LINK_EVENT = 'openchamber:install-extension';

/** A link from outside the app is a repository nobody here vetted, so the add dialog asks first. */
const requestFromLink = (url: string): void => requestGuestInstall({ source: url, confirmed: false });

export const useGuestInstallLinks = (): void => {
  React.useEffect(() => {
    const onLink = (event: Event): void => {
      // SAFETY: the desktop shell sends this event with `{ url }`; the value is checked below.
      const { url } = (event as CustomEvent<{ url?: string }>).detail ?? {};
      if (typeof url === 'string' && url) requestFromLink(url);
    };
    window.addEventListener(LINK_EVENT, onLink);
    void takePendingDesktopExtensionInstalls().then((urls) => urls.forEach(requestFromLink));
    return () => window.removeEventListener(LINK_EVENT, onLink);
  }, []);
};
