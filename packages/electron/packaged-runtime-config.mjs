
export const RUNTIME_CONFIG_SCRIPT_PATHNAME = '/__runtime-config.js';
const PACKAGED_UI_ORIGIN = 'openchamber-ui://app';

export const RUNTIME_CONFIG_SCRIPT = '(function(){var read=window.__OPENCHAMBER_READ_RUNTIME_CONFIG__;var c=read&&read();if(!c)return;if(window.__OPENCHAMBER_LOCAL_ORIGIN__===undefined){window.__OPENCHAMBER_LOCAL_ORIGIN__=c.localOrigin;}if(window.__OPENCHAMBER_API_BASE_URL__===undefined){window.__OPENCHAMBER_API_BASE_URL__=c.apiBaseUrl;}if(window.__OPENCHAMBER_CLIENT_TOKEN__===undefined&&c.clientToken){window.__OPENCHAMBER_CLIENT_TOKEN__=c.clientToken;}if(window.__OPENCHAMBER_RUNTIME_HEADERS__===undefined&&c.requestHeaders&&Object.keys(c.requestHeaders).length>0){window.__OPENCHAMBER_RUNTIME_HEADERS__=c.requestHeaders;}}())';

export const injectRuntimeConfig = (html, { pending }) => {
  if (pending) {
    const tag = `<script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}"></script>`;
    return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
  }
  const tag = `<script>${RUNTIME_CONFIG_SCRIPT}</script>`;
  if (html.includes('<head>')) return html.replace('<head>', `<head>${tag}`);
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
};

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

export const isRuntimeConfigFrame = (frame) => {
  try {
    return Boolean(frame) && frame.parent === null && frame.origin === PACKAGED_UI_ORIGIN;
  } catch {
    return false;
  }
};
