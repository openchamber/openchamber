
const LOCAL_SCHEMES = new Set(['about:', 'data:', 'blob:']);
const GUEST_PATH_PREFIXES = ['/api/guest-files/', '/api/guests/'];
const FILE_PREVIEW_ROUTE = '/api/fs/preview/';

const previewGrantOf = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const index = parsed.pathname.indexOf(FILE_PREVIEW_ROUTE);
  if (index < 0 || parsed.pathname.slice(0, index).includes('/api/')) return null;
  const rest = parsed.pathname.slice(index + FILE_PREVIEW_ROUTE.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return `${parsed.origin}${parsed.pathname.slice(0, index)}|${rest.slice(0, slash)}`;
};

const frameUrlOf = (frame) => {
  try {
    return frame.url;
  } catch {
    return null;
  }
};

const frameParentOf = (frame) => {
  try {
    return frame.parent;
  } catch {
    return null;
  }
};

/**
 * @param {{ isMainFrame: boolean, frameOrigin: string | undefined, frame?: import('electron').WebFrameMain | null, initiator?: import('electron').WebFrameMain | null, mainFrame?: import('electron').WebFrameMain | null, url: string, isAppOrigin: (url: string) => boolean }} input
 * @returns {boolean} true when the navigation must be refused
 */
export const shouldBlockGuestFrameNavigation = ({ isMainFrame, frameOrigin, frame, initiator, mainFrame, url, isAppOrigin }) => {
  if (isMainFrame || frameOrigin !== 'null') return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return true;
  }
  if (LOCAL_SCHEMES.has(target.protocol)) return false;
  if (!isAppOrigin(url)) return true;
  if (GUEST_PATH_PREFIXES.some((prefix) => target.pathname.startsWith(prefix))) return false;

  if (!frame || !mainFrame) return true;
  const currentUrl = frameUrlOf(frame);
  if (currentUrl === null) return true;
  const apiIndex = target.pathname.indexOf('/api/');
  if ((target.protocol === 'http:' || target.protocol === 'https:')
    && target.pathname.slice(apiIndex) === '/api/fs/raw'
    && currentUrl === '' && initiator === mainFrame && frameParentOf(frame) === mainFrame) return false;

  const targetGrant = previewGrantOf(url);
  if (!targetGrant) return true;
  const currentGrant = currentUrl ? previewGrantOf(currentUrl) : null;
  if (initiator === mainFrame && frameParentOf(frame) === mainFrame && (currentUrl === '' || currentGrant !== null)) {
    return false;
  }
  if (initiator === frame && currentGrant !== null && currentGrant === targetGrant) return false;
  return true;
};
