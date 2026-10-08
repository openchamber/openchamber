// Extension frames run sandboxed with an opaque origin and a CSP that keeps
// them off the network. A frame navigating itself is the one way out that no
// CSP inside the frame can stop: `location = 'https://anywhere/?data=…'`
// carries whatever it was shown in the URL. The desktop shell sees that
// navigation before any request is made (`will-frame-navigate`) and refuses
// it. The web runtime has no such hook; there the panel visibly leaves.
//
// Only opaque-origin subframes are judged. The app's HTML-preview frame is
// sandboxed without allow-same-origin, so it has an opaque origin too, and
// origin alone cannot tell it from an extension.

const LOCAL_SCHEMES = new Set(['about:', 'data:', 'blob:']);
const GUEST_PATH_PREFIX = '/api/guests/';
const FILE_PREVIEW_ROUTE = '/api/fs/preview/';

/**
 * The grant of an HTML-preview page URL (`<host prefix>/api/fs/preview/<grant>/<path>`),
 * or null for any other address. A host served under a sub-path puts its
 * prefix before `/api/`.
 */
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

// A detached frame throws on access and cannot prove it belongs to the app.
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
  // No network request: the document is built from what the frame already has.
  if (LOCAL_SCHEMES.has(target.protocol)) return false;
  if (!isAppOrigin(url)) return true;
  // Another page of an extension on this app's server, which the same CSP governs.
  if (target.pathname.startsWith(GUEST_PATH_PREFIX)) return false;

  if (!frame || !mainFrame) return true;
  const currentUrl = frameUrlOf(frame);
  if (currentUrl === null) return true;
  // A new PDF iframe also starts with an opaque origin in the packaged UI.
  // Only the app may load the raw-file route into its empty direct child;
  // loaded extensions, HTML previews and nested frames never qualify.
  const apiIndex = target.pathname.indexOf('/api/');
  if ((target.protocol === 'http:' || target.protocol === 'https:')
    && target.pathname.slice(apiIndex) === '/api/fs/raw'
    && currentUrl === '' && initiator === mainFrame && frameParentOf(frame) === mainFrame) return false;

  // HTML previews: the sandboxed page is untrusted, so the grant in its path is
  // what bounds it.
  const targetGrant = previewGrantOf(url);
  if (!targetGrant) return true;
  const currentGrant = currentUrl ? previewGrantOf(currentUrl) : null;
  // The app loads a preview into its own direct child frame: the first load
  // into an empty frame, or a new grant after the file is saved. An extension
  // frame (whose URL is a guest page) never qualifies.
  if (initiator === mainFrame && frameParentOf(frame) === mainFrame && (currentUrl === '' || currentGrant !== null)) {
    return false;
  }
  // The preview follows its own links between pages of the same grant, as in
  // the web runtime. It cannot reach another grant or any other route.
  if (initiator === frame && currentGrant !== null && currentGrant === targetGrant) return false;
  return true;
};
