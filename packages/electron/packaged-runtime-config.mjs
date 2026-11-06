/**
 * How a packaged application document receives its runtime values (local
 * origin, API base, client token, request headers) from main.
 *
 * The scheme answers any frame in the app's session, and the request gives main
 * nothing to tell the frames apart: no fetch metadata, no origin, the same mode
 * for every kind of load. So served documents hold no values. A script at the
 * top of <head> asks main for them through the preload bridge, and main checks
 * the frame that asked (see isRuntimeConfigFrame).
 *
 * On a plain local launch main navigates to the application before the local
 * server is listening, so the values do not exist yet: the document then ends
 * with a parser-blocking script that main answers once startup has resolved.
 * Meanwhile Chromium parses and paints the document and fetches and compiles its
 * module scripts, but module scripts run only after parsing finishes, so no
 * application code runs, and no request leaves the renderer, before the values
 * are set.
 */

export const RUNTIME_CONFIG_SCRIPT_PATHNAME = '/__runtime-config.js';
const PACKAGED_UI_ORIGIN = 'openchamber-ui://app';

/**
 * Sets the values the bridge returns. A frame without the bridge sets nothing,
 * and a value the preload already exposed for this window stays.
 */
export const RUNTIME_CONFIG_SCRIPT = '(function(){var read=window.__OPENCHAMBER_READ_RUNTIME_CONFIG__;var c=read&&read();if(!c)return;if(window.__OPENCHAMBER_LOCAL_ORIGIN__===undefined){window.__OPENCHAMBER_LOCAL_ORIGIN__=c.localOrigin;}if(window.__OPENCHAMBER_API_BASE_URL__===undefined){window.__OPENCHAMBER_API_BASE_URL__=c.apiBaseUrl;}if(window.__OPENCHAMBER_CLIENT_TOKEN__===undefined&&c.clientToken){window.__OPENCHAMBER_CLIENT_TOKEN__=c.clientToken;}if(window.__OPENCHAMBER_RUNTIME_HEADERS__===undefined&&c.requestHeaders&&Object.keys(c.requestHeaders).length>0){window.__OPENCHAMBER_RUNTIME_HEADERS__=c.requestHeaders;}}())';

export const injectRuntimeConfig = (html, { pending }) => {
  if (pending) {
    const tag = `<script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}"></script>`;
    // At the end of the body, so the document's own loading screen is parsed
    // and painted while the script waits.
    return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
  }
  const tag = `<script>${RUNTIME_CONFIG_SCRIPT}</script>`;
  if (html.includes('<head>')) return html.replace('<head>', `<head>${tag}`);
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
};

/** Held from the early navigation until startup has resolved. While held, documents are served with the blocking script and its request waits. */
export const createRuntimeConfigGate = () => {
  let held = null;
  let release = null;
  return {
    hold() {
      if (held) return;
      held = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      held = null;
      release = null;
    },
    isHeld: () => held !== null,
    whenReleased: () => held ?? Promise.resolve(),
  };
};

/** Only the top frame of a window, showing the packaged application itself. */
export const isRuntimeConfigFrame = (frame) => {
  try {
    return Boolean(frame) && frame.parent === null && frame.origin === PACKAGED_UI_ORIGIN;
  } catch {
    // Reading a frame that is already gone throws.
    return false;
  }
};
