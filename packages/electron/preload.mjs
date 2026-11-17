import { contextBridge, ipcRenderer, webUtils } from 'electron';

const eventListeners = new Map();

const readArgValue = (name) => {
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => typeof value === 'string' && value.startsWith(prefix));
  if (!entry) {
    return '';
  }
  return entry.slice(prefix.length);
};

const localOrigin = readArgValue('--openchamber-local-origin');
const devUiOrigin = readArgValue('--openchamber-dev-ui-origin');
const apiBaseUrl = readArgValue('--openchamber-api-base-url');
const clientToken = readArgValue('--openchamber-client-token');
const runtimeHeadersRaw = readArgValue('--openchamber-runtime-headers');
const homeDirectory = readArgValue('--openchamber-home');
const macosMajorRaw = readArgValue('--openchamber-macos-major');
const macosMajor = Number.parseInt(macosMajorRaw, 10);
const trayEnabled = process.platform !== 'darwin' || readArgValue('--openchamber-tray-enabled') !== '0';
const nativeFrame = readArgValue('--openchamber-native-frame') === '1';

const currentOrigin = (() => {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
})();
const isLocalPage = currentOrigin !== 'null'
  && (currentOrigin === 'openchamber-ui://app'
  || (localOrigin && currentOrigin === localOrigin)
  || (devUiOrigin && currentOrigin === devUiOrigin));

if (localOrigin) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_LOCAL_ORIGIN__', localOrigin);
}

if (apiBaseUrl) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_API_BASE_URL__', apiBaseUrl);
}

if (clientToken && isLocalPage) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_CLIENT_TOKEN__', clientToken);
}

if (currentOrigin === 'openchamber-ui://app') {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_READ_RUNTIME_CONFIG__', () => ipcRenderer.sendSync('openchamber:read-runtime-config'));
}

const relayHostId = readArgValue('--openchamber-relay-host-id');
if (relayHostId && isLocalPage) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_RELAY_HOST_ID__', relayHostId);
}

if (readArgValue('--openchamber-explicit-runtime') === '1') {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_EXPLICIT_RUNTIME__', true);
}

if (runtimeHeadersRaw && isLocalPage) {
  try {
    const runtimeHeaders = JSON.parse(runtimeHeadersRaw);
    if (runtimeHeaders && typeof runtimeHeaders === 'object' && Object.keys(runtimeHeaders).length > 0) {
      contextBridge.exposeInMainWorld('__OPENCHAMBER_RUNTIME_HEADERS__', runtimeHeaders);
    }
  } catch {
  }
}

if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_HOME__', homeDirectory);
}

if (Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_MACOS_MAJOR__', macosMajor);
}

contextBridge.exposeInMainWorld('__OPENCHAMBER_ELECTRON__', {
  runtime: 'electron',
  arch: process.arch,
  trayEnabled,
  nativeFrame,
});

contextBridge.exposeInMainWorld('__OPENCHAMBER_PLATFORM__', process.platform);

const isStartupSplash = (() => {
  try {
    return location.protocol === 'data:' || location.pathname === '/__splash';
  } catch {
    return false;
  }
})();
if (!isStartupSplash && ipcRenderer.sendSync('openchamber:take-safe-start') === true) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_SAFE_START__', true);
}


const addListener = (event, handler) => {
  const listeners = eventListeners.get(event) || new Set();
  listeners.add(handler);
  eventListeners.set(event, listeners);

  return () => {
    const current = eventListeners.get(event);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      eventListeners.delete(event);
    }
  };
};

const dispatchNativeEvent = (event, detail) => {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener({ payload: detail });
      } catch (error) {
        console.error(`[electron:preload] listener failed for ${event}:`, error);
      }
    }
  }

  try {
    const domEvent = detail === undefined
      ? new Event(event)
      : new CustomEvent(event, { detail });
    window.dispatchEvent(domEvent);
  } catch (error) {
    console.error(`[electron:preload] failed to dispatch DOM event ${event}:`, error);
  }
};

ipcRenderer.on('openchamber:emit', (_evt, payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = typeof payload.event === 'string' ? payload.event : '';
  if (!event) {
    return;
  }

  dispatchNativeEvent(event, payload.detail);
});

const relayDevTunnelPorts = new Map();
let relayDevTunnelHandler = null;
ipcRenderer.on('openchamber:relay-dev-tunnel-connect', (event, payload) => {
  if (!isLocalPage || !payload || typeof payload.connectionId !== 'string' || !event.ports?.[0]) return;
  const port = event.ports[0];
  relayDevTunnelPorts.set(payload.connectionId, port);
  const spaceId = payload.spaceId ?? null;
  port.onmessage = (messageEvent) => relayDevTunnelHandler?.({
    connectionId: payload.connectionId,
    remotePort: payload.remotePort,
    spaceId,
    message: messageEvent.data,
  });
  port.start();
  relayDevTunnelHandler?.({ connectionId: payload.connectionId, remotePort: payload.remotePort, spaceId, message: { type: 'connect' } });
});

const desktopBridge = {
  invoke: (cmd, args) => ipcRenderer.invoke('openchamber:invoke', cmd, args || {}),
  openDialog: (options) => ipcRenderer.invoke('openchamber:dialog:open', options || {}),
  grantFileAccess: (filePath) => ipcRenderer.invoke('openchamber:file:grant-existing', filePath),
  openExternal: (url) => ipcRenderer.invoke('openchamber:invoke', 'desktop_open_external_url', { url }),
  listen: async (event, handler) => addListener(event, handler),
  pathForFile: (file) => webUtils.getPathForFile(file),
};

if (isLocalPage) {
  desktopBridge.pickThemeFile = () => ipcRenderer.invoke('openchamber:invoke', 'desktop_pick_theme_file', {});
  if (process.platform === 'linux') {
    desktopBridge.clipboard = {
      readSelection: () => ipcRenderer.invoke('openchamber:invoke', 'desktop_clipboard_read_selection', {}),
      writeSelection: (text) => ipcRenderer.invoke('openchamber:invoke', 'desktop_clipboard_write_selection', { text }),
    };
  }
  desktopBridge.relayDevTunnelListen = (handler) => {
    relayDevTunnelHandler = typeof handler === 'function' ? handler : null;
  };
  desktopBridge.relayDevTunnelPost = (connectionId, message) => {
    relayDevTunnelPorts.get(connectionId)?.postMessage(message);
    if (message?.type === 'close') relayDevTunnelPorts.delete(connectionId);
  };
}

contextBridge.exposeInMainWorld('__OPENCHAMBER_DESKTOP__', desktopBridge);
