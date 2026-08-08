// Remote-page shell overlay (Electron main process).
//
// The OpenChamber UI renders its own window chrome — title-bar drag regions
// and the instance switcher — everywhere it runs, including when it is served
// from a remote instance origin (managed SSH servers serve the same UI). But
// a configured instance can also serve a FOREIGN page (e.g. an `opencode web`
// server on a VPS that the user added as a remote instance). Such a page has
// neither a `-webkit-app-region` drag region (the frameless window becomes
// impossible to move on Windows/Linux) nor any way to get back to the local
// OpenChamber instance.
//
// This module builds the tiny overlay the main process injects into foreign
// pages loaded inside OpenChamber windows: a slim draggable bar with a
// "Back to OpenChamber" button that navigates back to the local UI. The
// injection is additive and self-contained (inline styles, one button), and
// never runs on OpenChamber UI documents or on local/packaged pages.

export const OPENCHAMBER_UI_MARKER_ATTR = 'data-oc-ui';
export const REMOTE_SHELL_BAR_ID = 'oc-remote-shell';
export const REMOTE_SHELL_BACK_BUTTON_ID = 'oc-remote-shell-back';

const REMOTE_SHELL_BAR_HEIGHT_PX = 28;

/**
 * Decide whether the remote-page shell should be injected for a page.
 *
 * Pure decision helper; the injected script embeds a serialized copy of this
 * function so main-process logic and in-page behavior cannot drift apart.
 *
 * @param {object} page
 * @param {string} page.protocol  `window.location.protocol` of the page.
 * @param {string} page.origin    `window.location.origin` of the page.
 * @param {string} page.openChamberUiMarker  value of the OpenChamber UI marker attribute.
 * @param {string} page.localOrigin  `window.__OPENCHAMBER_LOCAL_ORIGIN__` ('' when absent).
 * @returns {boolean} true when the shell bar should be injected.
 */
export const remoteShellPageShouldInject = ({ protocol, origin, openChamberUiMarker, localOrigin }) => {
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (!origin || origin === 'null') return false;
  // OpenChamber UI documents (local, packaged, or remote-origin) render their
  // own chrome: drag regions plus the instance switcher. The literal is
  // intentional: this function is serialized into the injected page script,
  // so it must not reference module-scope constants.
  if (openChamberUiMarker === 'openchamber') return false;
  if (localOrigin) {
    try {
      if (new URL(localOrigin).origin === origin) return false;
    } catch {
      // Unparseable local origin is not a reason to overlay a foreign page.
    }
  }
  return true;
};

/**
 * Build the IIFE injected into foreign pages rendered inside OpenChamber
 * windows. The script is defensive (try/catch, idempotent, no globals) and
 * contains no secrets: the only dynamic value is the local UI URL, which the
 * preload already exposes to remote pages as `__OPENCHAMBER_LOCAL_ORIGIN__`.
 *
 * @param {object} options
 * @param {string} options.localUiUrl  URL to navigate to when "Back to
 *   OpenChamber" is pressed (packaged UI URL, or the local server origin).
 * @returns {string} executable JavaScript.
 */
export const buildRemoteShellInjectionScript = ({ localUiUrl }) => {
  const backTarget = JSON.stringify(localUiUrl || '');
  const guardSource = remoteShellPageShouldInject.toString();
  const barHeight = REMOTE_SHELL_BAR_HEIGHT_PX;
  return [
    '(function () {',
    '  try {',
    `    if (document.getElementById(${JSON.stringify(REMOTE_SHELL_BAR_ID)})) return;`,
    '    var docRoot = document.documentElement;',
    '    if (!docRoot) return;',
    '    var shouldInject = (',
    `      ${guardSource}`,
    '    )({',
    '      protocol: window.location && window.location.protocol || \'\',',
    '      origin: window.location && window.location.origin || \'\',',
    '      openChamberUiMarker: docRoot.getAttribute(\'data-oc-ui\') || \'\',',
    '      localOrigin: window.__OPENCHAMBER_LOCAL_ORIGIN__ || \'\',',
    '    });',
    '    if (!shouldInject) return;',
    `    var backTarget = ${backTarget};`,
    '    if (!backTarget) return;',
    '    var bar = document.createElement(\'div\');',
    `    bar.id = ${JSON.stringify(REMOTE_SHELL_BAR_ID)};`,
    `    bar.setAttribute('data-oc-remote-shell', '1');`,
    '    bar.setAttribute(\'role\', \'region\');',
    '    bar.setAttribute(\'aria-label\', \'OpenChamber remote instance\');',
    `    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:${barHeight}px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:0 10px 0 8px;box-sizing:border-box;-webkit-app-region:drag;user-select:none;cursor:default;background:rgba(21,19,19,0.94);border-bottom:1px solid rgba(255,255,255,0.14);font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,ui-sans-serif,system-ui,sans-serif;color:#e8e6df;';`,
    '    var mark = document.createElement(\'span\');',
    '    mark.setAttribute(\'aria-hidden\', \'true\');',
    '    mark.style.cssText = \'display:inline-block;width:14px;height:14px;border-radius:4px;background:#edb449;flex-shrink:0;\';',
    '    bar.appendChild(mark);',
    '    var label = document.createElement(\'span\');',
    '    label.textContent = \'OpenChamber\';',
    '    label.style.cssText = \'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\';',
    '    bar.appendChild(label);',
    '    var back = document.createElement(\'button\');',
    `    back.id = ${JSON.stringify(REMOTE_SHELL_BACK_BUTTON_ID)};`,
    '    back.type = \'button\';',
    '    back.textContent = \'← Back to OpenChamber\';',
    `    back.setAttribute('title', 'Return to the local OpenChamber instance');`,
    '    back.style.cssText = \'margin-left:auto;-webkit-app-region:no-drag;pointer-events:auto;appearance:none;border:1px solid rgba(255,255,255,0.22);border-radius:6px;background:rgba(255,255,255,0.10);color:#ffffff;padding:3px 10px;font:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0;\';',
    '    back.addEventListener(\'click\', function () {',
    '      try { window.location.assign(backTarget); } catch (_) { window.location.href = backTarget; }',
    '    });',
    '    back.addEventListener(\'mouseenter\', function () { back.style.background = \'rgba(255,255,255,0.18)\'; });',
    '    back.addEventListener(\'mouseleave\', function () { back.style.background = \'rgba(255,255,255,0.10)\'; });',
    '    bar.appendChild(back);',
    '    (document.body || docRoot).appendChild(bar);',
    '  } catch (_e) { /* The overlay is best-effort; never break the remote page. */ }',
    '}())',
  ].join('\n');
};
