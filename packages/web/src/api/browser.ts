import type { BrowserControlAPI } from '@openchamber/ui/lib/api/types';
import { createBrowserControlClient } from '@openchamber/ui/lib/browserControlApi';

/**
 * Web/desktop BrowserControlAPI. The client is platform-agnostic — the browser
 * pane decides its backend ('web-iframe' or 'desktop-cdp') and supplies the
 * executor when it registers as a controller.
 */
export const createWebBrowserAPI = (): BrowserControlAPI => createBrowserControlClient();
