import { contextBridge, ipcRenderer } from 'electron';

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
const homeDirectory = readArgValue('--openchamber-home');
const macosMajorRaw = readArgValue('--openchamber-macos-major');
const macosMajor = Number.parseInt(macosMajorRaw, 10);

// Preload is re-executed on every in-window navigation (we run with
// sandbox:false, per-document). Only expose desktop-shell APIs when the
// current document is our local UI — on remote hosts the renderer must
// look like a plain web page so isDesktopShell() returns false and the
// UI doesn't try to invoke desktop_* IPC (which the main-process origin
// gate would reject anyway, but that surfaces as a user-visible error).
const currentOrigin = (() => {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
})();
const isLoopbackOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(currentOrigin);
const isLocalPage = currentOrigin === 'null'
  || isLoopbackOrigin
  || (localOrigin && currentOrigin === localOrigin);

if (isLocalPage && localOrigin) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_LOCAL_ORIGIN__', localOrigin);
}

if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_HOME__', homeDirectory);
}

if (isLocalPage && Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_MACOS_MAJOR__', macosMajor);
}

// Note: bootOutcome must stay writable from the main world's initScript so
// re-navigations (host switch via deep link) can refresh it. contextBridge-
// exposed globals are read-only, which blocks that update — rely solely on
// the main-process initScript injection (dispatched on did-finish-load).

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

if (isLocalPage) {
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
}

if (isLocalPage) {
  contextBridge.exposeInMainWorld('__TAURI__', {
    core: {
      invoke: (cmd, args) => ipcRenderer.invoke('openchamber:invoke', cmd, args || {}),
    },
    dialog: {
      open: (options) => ipcRenderer.invoke('openchamber:dialog:open', options || {}),
    },
    event: {
      listen: async (event, handler) => addListener(event, handler),
    },
  });

  contextBridge.exposeInMainWorld('__OPENCHAMBER_ELECTRON__', {
    runtime: 'electron',
  });
}
