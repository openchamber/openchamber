import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';

export function installNativeElectron({ directory, app: appOverrides = {}, fetch, onNavigate = () => {} }) {
  const windows = [];
  const handlers = new Map();
  const nativeSession = Object.assign(new EventEmitter(), {
    getUserAgent: () => 'Chrome/145.0.0.0', setUserAgent() {}, registerPreloadScript() {},
    clearCache: async () => {}, getPreloads: () => [], setPreloads() {},
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {},
    webRequest: { onBeforeSendHeaders() {}, onHeadersReceived() {} },
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, isReady: () => true,
    whenReady: () => new Promise(() => {}),
    getPath: () => directory, getAppPath: () => directory,
    getVersion: () => '2.7.2', getName: () => 'OpenChamber Test',
    isDefaultProtocolClient: () => true,
    exit: (code) => { throw new Error(`Unexpected app exit: ${code}`); },
    focus() {},
    dock: { setBadge() {}, setIcon() {}, setMenu() {}, show: async () => {}, hide() {} },
  }, appOverrides);
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.id = windows.length + 1;
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        id: this.id, session: nativeSession, getURL: () => this.url || '',
        isDestroyed: () => this.isDestroyed(),
        setWindowOpenHandler() {}, send() {}, setZoomMode() {},
        executeJavaScript: async () => {}, insertCSS: async () => '',
        setBackgroundThrottling() {},
      });
      windows.push(this);
    }
    static getAllWindows() { return windows.filter((window) => !window.isDestroyed()); }
    static fromWebContents(contents) { return windows.find((window) => window.webContents === contents) || null; }
    static getFocusedWindow() { return BrowserWindow.getAllWindows().at(-1) || null; }
    isDestroyed() { return this.destroyed === true; }
    isVisible() { return true; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    show() {}
    focus() {}
    setTitle() {}
    async loadURL(url) {
      this.url = url;
      queueMicrotask(() => this.emit('ready-to-show'));
      onNavigate(this, url);
    }
  }
  const electron = {
    app, BrowserWindow, autoUpdater: new EventEmitter(),
    clipboard: {}, ClipboardItem: class {}, dialog: {},
    globalShortcut: { register: () => true, isRegistered: () => false, unregister() {}, unregisterAll() {} },
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) }),
    Menu: { buildFromTemplate: () => new EventEmitter(), setApplicationMenu() {} },
    MessageChannelMain: class {}, nativeTheme: new EventEmitter(),
    net: { fetch }, Notification: class {},
    Tray: class extends EventEmitter {
      setIgnoreDoubleClickEvents() {}
      setTitle() {}
      setImage() {}
      setToolTip() {}
      setContextMenu() {}
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    powerMonitor: new EventEmitter(), powerSaveBlocker: {},
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    screen: {
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
    },
    session: { defaultSession: nativeSession, fromPartition: () => nativeSession },
    shell: {}, webContents: {},
    systemPreferences: { getUserDefault: () => '', setUserDefault() {} },
  };
  const log = {
    initialize() {},
    transports: { file: { getFile: () => { throw new Error('no log file'); } }, console: {} },
    functions: {}, info() {}, warn() {}, debug() {}, error() {},
  };
  globalThis.nativeElectronTestEdges = { electron, log };
  if (fetch) globalThis.fetch = fetch;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'electron' || specifier === 'electron-log/main.js') {
        return { url: new URL(specifier === 'electron' ? './electron.cjs' : './log.cjs', import.meta.url).href, shortCircuit: true };
      }
      return nextResolve(specifier, { ...context, conditions: [...context.conditions, 'openchamber-source'] });
    },
    load(url, context, nextLoad) {
      if (url === new URL('./electron.cjs', import.meta.url).href) {
        return { format: 'commonjs', shortCircuit: true, source: Object.keys(electron)
          .map((name) => `exports.${name} = globalThis.nativeElectronTestEdges.electron.${name};`).join('\n') };
      }
      if (url === new URL('./log.cjs', import.meta.url).href) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = globalThis.nativeElectronTestEdges.log;' };
      }
      return nextLoad(url, context);
    },
  });
  return { electron, app, windows, handlers, hooks };
}
