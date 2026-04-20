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

// Preload re-executes on every cross-origin navigation (we run with
// sandbox:false, per-document). Two separate concerns to balance:
//  - __OPENCHAMBER_ELECTRON__ is a shell-identity flag (no capability).
//    Remote UIs still need it so isDesktopShell() returns true and the
//    window renders with desktop affordances (DesktopHostSwitcher,
//    title bar offsets, etc.). Expose unconditionally.
//  - __TAURI__ is the IPC channel to the main process. Remote pages must
//    not get it — otherwise any page loaded via DesktopHostSwitcher could
//    read local files, open apps, relaunch, etc. Expose only on local
//    pages (loopback / state.localOrigin / file:// for dev).
// Everything driven by localOrigin (home dir, macOS hints) also stays
// local-only since it leaks info about the Electron host machine.
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

// Remote pages need __OPENCHAMBER_LOCAL_ORIGIN__ so the HostSwitcher knows
// the URL of the Local entry (isDesktopLocalOriginActive() falls back to
// window.location.origin otherwise — wrong on remote). Low risk: the value
// is just "http://127.0.0.1:<port>" which is not exploitable without the
// IPC channel, and CORS on the local server prevents remote-origin fetches.
if (localOrigin) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_LOCAL_ORIGIN__', localOrigin);
}

// Home directory leaks the OS username — keep local-only. Remote pages
// operate on the REMOTE server's filesystem, local home is irrelevant
// (and would be misleading if consumed as a workspace hint).
if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_HOME__', homeDirectory);
}

// macOS major version drives window chrome offsets (traffic lights) — UI
// presentation only, safe to expose.
if (Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_MACOS_MAJOR__', macosMajor);
}

contextBridge.exposeInMainWorld('__OPENCHAMBER_ELECTRON__', {
  runtime: 'electron',
});

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

// Main-process events are read-only notifications (update progress,
// window focus, etc.) — safe to deliver to any page rendered in this
// webContents. The events themselves don't grant capability.
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

// __TAURI__ is exposed on all pages; the main-process gate in
// ipcMain.handle('openchamber:invoke') decides per-command what is safe
// for non-local callers (window/host-switcher ops yes, file/shell ops
// no). See COMMANDS_SAFE_FOR_REMOTE in main.mjs.
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
