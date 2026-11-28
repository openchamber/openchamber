import { parseAutoOpenableExternalUrl } from './external-url-policy.mjs';
import { shouldBlockGuestFrameNavigation } from './guest-frame-navigation.mjs';

const withoutTrailingSlashes = (pathname) => pathname.replace(/\/+$/, '');

const savedUrls = (host) => [host.url, host.apiUrl]
  .filter((candidate) => candidate && URL.canParse(candidate))
  .map((candidate) => new URL(candidate));

const isWithinPath = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export const findSavedHostForUrl = (raw, hosts) => {
  if (!URL.canParse(raw)) return null;
  const link = new URL(raw);
  if (link.origin === 'null') return null;
  const linkPath = withoutTrailingSlashes(link.pathname);
  let found = null;
  let foundPathLength = -1;
  for (const host of hosts) {
    for (const saved of savedUrls(host)) {
      if (saved.origin !== link.origin) continue;
      const savedPath = withoutTrailingSlashes(saved.pathname);
      const pathLength = isWithinPath(linkPath, savedPath) ? savedPath.length : -1;
      if (!found || pathLength > foundPathLength) {
        found = host;
        foundPathLength = pathLength;
      }
    }
  }
  return found;
};

export const opensHostWindow = (raw, host, { sessionRouteFromUrl }) => {
  if (sessionRouteFromUrl(raw)) return true;
  const link = new URL(raw);
  const linkPath = withoutTrailingSlashes(link.pathname);
  return savedUrls(host).some((saved) => saved.origin === link.origin && withoutTrailingSlashes(saved.pathname) === linkPath);
};

export const attachWindowNavigationGuards = ({
  webContents,
  uiProtocol,
  getAllowedOrigins,
  findConfiguredHostForUrl,
  sessionRouteFromUrl,
  openHostWindow,
  onOpenSession,
  openExternal,
  log,
  routeLinks = true,
}) => {
  const isAllowedNavigationUrl = (raw, { includeHosts = true, includeCurrentOrigin = true } = {}) => {
    try {
      const url = new URL(raw);
      if (url.protocol === 'devtools:') return true;
      if (url.protocol === `${uiProtocol}:`) return true;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (includeCurrentOrigin) {
        try {
          if (new URL(webContents.getURL()).origin === url.origin) return true;
        } catch {
        }
      }
      for (const candidate of getAllowedOrigins()) {
        if (!candidate) continue;
        try {
          if (new URL(candidate).origin === url.origin) return true;
        } catch {
        }
      }
      return includeHosts && findConfiguredHostForUrl(raw) !== null;
    } catch {
      return false;
    }
  };

  const openInBrowser = (url) => {
    const external = parseAutoOpenableExternalUrl(url);
    if (external) {
      void openExternal(external.toString()).catch(() => {});
    }
  };

  webContents.setWindowOpenHandler(({ url }) => {
    if (routeLinks) {
      const host = findConfiguredHostForUrl(url);
      if (host && opensHostWindow(url, host, { sessionRouteFromUrl })) {
        void openHostWindow(host, sessionRouteFromUrl(url), { reuseOpenWindow: true }).catch((error) => {
          log.warn('[electron] failed to open host window from link:', error);
        });
        return { action: 'deny' };
      }
      if (!host && isAllowedNavigationUrl(url, { includeHosts: false })) {
        const route = sessionRouteFromUrl(url);
        if (route) onOpenSession(route);
        return { action: 'deny' };
      }
    }
    openInBrowser(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url, { includeHosts: routeLinks, includeCurrentOrigin: routeLinks })) return;
    event.preventDefault();
    openInBrowser(url);
  });

  webContents.on('will-frame-navigate', (details) => {
    let frameOrigin;
    try {
      frameOrigin = details.frame?.origin;
    } catch {
      frameOrigin = undefined;
    }
    if (!shouldBlockGuestFrameNavigation({
      isMainFrame: details.isMainFrame,
      frameOrigin,
      frame: details.frame,
      initiator: details.initiator,
      mainFrame: webContents.mainFrame,
      url: details.url,
      isAppOrigin: isAllowedNavigationUrl,
    })) return;
    details.preventDefault();
    let host = '';
    try {
      host = new URL(details.url).host;
    } catch {
      host = '';
    }
    log.warn(`[guests] refused an extension frame navigating to ${host || 'an invalid URL'}`);
  });
};
