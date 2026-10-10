/**
 * How a packaged application document receives its runtime values (local
 * origin, API base, client token) from main.
 *
 * Normally they are inlined at the top of <head>. On a plain local launch main
 * navigates to the application before the local server is listening, so the
 * values do not exist yet: the document then ends with a parser-blocking script
 * that main answers once startup has resolved. Meanwhile Chromium parses and
 * paints the document and fetches and compiles its module scripts, but module
 * scripts run only after parsing finishes, so no application code runs, and no
 * request leaves the renderer, before the values are set.
 */

import { randomUUID } from 'node:crypto';

export const RUNTIME_CONFIG_SCRIPT_PATHNAME = '/__runtime-config.js';
const NONCE_PARAM = 'nonce';

/**
 * `nonce` is required when pending: the script carries the client token, so
 * it is answered only to the document it was issued to (see
 * claimRuntimeConfigScriptRequest).
 */
export const injectRuntimeConfig = (html, { scriptBody, pending, nonce = '' }) => {
  if (pending) {
    const src = `${RUNTIME_CONFIG_SCRIPT_PATHNAME}?${NONCE_PARAM}=${encodeURIComponent(nonce)}`;
    const tag = `<script src="${src}"></script>`;
    // At the end of the body, so the document's own loading screen is parsed
    // and painted while the script waits.
    return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
  }
  const tag = `<script>${scriptBody}</script>`;
  if (html.includes('<head>')) return html.replace('<head>', `<head>${tag}`);
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
};

/**
 * Held from the early navigation until startup has resolved. While held,
 * documents are served with the blocking script and its request waits.
 *
 * Every pending document gets its own single-use nonce in the script URL. A
 * classic <script src> is not subject to CORS, so without it any frame able to
 * name openchamber-ui://app (a sandboxed HTML preview, a plugin srcdoc) could
 * load the script and read the client token. The nonce exists only inside the
 * served document, which such a frame cannot read.
 */
export const createRuntimeConfigGate = ({ createNonce = randomUUID } = {}) => {
  let held = null;
  let release = null;
  const issuedNonces = new Set();
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
    issueScriptNonce() {
      const nonce = createNonce();
      issuedNonces.add(nonce);
      return nonce;
    },
    claimScriptNonce(nonce) {
      if (typeof nonce !== 'string' || !issuedNonces.has(nonce)) return false;
      issuedNonces.delete(nonce);
      return true;
    },
  };
};

/**
 * Decides whether a request for the runtime config script may be answered.
 * Only a script load carrying a nonce this gate issued and nobody claimed yet
 * passes; the nonce is spent on success. Fetch metadata, when Chromium sends
 * it, must also describe a same-origin script load.
 */
export const claimRuntimeConfigScriptRequest = (gate, { url, headers }) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname !== RUNTIME_CONFIG_SCRIPT_PATHNAME) return false;
  const dest = headers?.get?.('sec-fetch-dest');
  if (dest && dest !== 'script') return false;
  const site = headers?.get?.('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  return gate.claimScriptNonce(parsed.searchParams.get(NONCE_PARAM));
};
