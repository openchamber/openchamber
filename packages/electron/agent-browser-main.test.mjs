import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  AGENT_BROWSER_PARTITION, BROWSER_PANEL_PARTITION, buildAgentBrowserPolicy,
  isStandaloneBrowserPanelPartition, shouldCancelAgentBrowserRequest,
} from './agent-browser-policy.mjs';
import {
  browserPanelPermissionAuditDetails, browserPanelWindowOpenTarget, plainChromeUserAgent,
  shouldAllowBrowserPanelCertificateError, shouldAllowBrowserPanelPermission,
} from './browser-panel-security.mjs';
import { spaceIdOfPreviewPartition } from './space-preview.mjs';

// Package precedent: evaluate main's real boundaries without starting Electron.
// These tests cover wiring; Chromium interception still needs native QA.
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const declaration = (name) => {
  const start = main.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, name);
  const end = main.indexOf('\n};', start);
  assert.notEqual(end, -1, name);
  return main.slice(start, end + 3);
};
const shared = {
  AGENT_BROWSER_PARTITION, BROWSER_PANEL_PARTITION, buildAgentBrowserPolicy,
  isStandaloneBrowserPanelPartition, shouldCancelAgentBrowserRequest,
  spaceIdOfPreviewPartition,
};

const harness = () => {
  let settings = { desktopHosts: [{ url: 'https://front.example', apiUrl: 'http://10.0.0.5:7000' }] };
  let readError = null;
  let tunnelUrl = 'https://tunnel.example';
  const sessions = new Map();
  const panelSessions = new Set();
  const fromPartition = (partition) => {
    if (!sessions.has(partition)) sessions.set(partition, {
      getUserAgent: () => 'Chrome/140 Electron/45', setUserAgent() {},
      registerPreloadScript() {},
      setPermissionRequestHandler(handler) { this.requestPermission = handler; },
      setPermissionCheckHandler(handler) { this.checkPermission = handler; },
      setDevicePermissionHandler(handler) { this.devicePermission = handler; },
      webRequest: { onBeforeRequest(handler) { this.beforeRequest = handler; } },
    });
    return sessions.get(partition);
  };
  const state = { sidecarUrl: 'http://127.0.0.1:3901', serverHandle: { getTunnelUrl: () => tunnelUrl } };
  const window = { isDestroyed: () => false, webContents: { getURL: () => 'openchamber-ui://app' }, __ocRuntimeConfig: { apiBaseUrl: 'https://window.example' } };
  const context = {
    ...shared, state, panelSessions, isPanelSession: (candidate) => panelSessions.has(candidate),
    fs: { readFileSync: () => { if (readError) throw readError; return JSON.stringify(settings); } },
    settingsFilePath: () => '/synthetic/settings.json',
    os: { networkInterfaces: () => ({ eth0: [{ address: '192.168.1.10' }] }) },
    BrowserWindow: { getAllWindows: () => [window] }, browserPanelPopups: new Set(),
    process: { env: { OPENCHAMBER_SERVER_URL: 'https://env.example' } },
    session: { fromPartition }, app: { on() {} },
    plainChromeUserAgent, shouldAllowBrowserPanelPermission,
    shouldAllowBrowserPanelCertificateError, browserPanelPermissionAuditDetails,
    resolveBrowserPanelPreloadPath: () => '/synthetic/preload.cjs',
    log: { info() {}, warn() {} },
  };
  const harden = vm.runInNewContext([
    declaration('currentAgentBrowserPolicy'), declaration('hardenPanelSession'),
    declaration('hardenBrowserPanelSession'), 'hardenBrowserPanelSession;',
  ].join('\n'), context);
  harden();
  return {
    context, fromPartition, state, window,
    setSettings: (next) => { settings = next; },
    setReadError: (error) => { readError = error; },
    setTunnelUrl: (next) => { tunnelUrl = next; },
    cancel: (url, resourceType = 'xhr') => {
      let decision;
      fromPartition(AGENT_BROWSER_PARTITION).webRequest.beforeRequest({ url, resourceType }, (response) => { decision = response.cancel; });
      return decision;
    },
  };
};

test('main installs the all-resource request filter only on the hardened agent session', () => {
  const h = harness();
  assert.equal(h.fromPartition(BROWSER_PANEL_PARTITION).webRequest.beforeRequest, undefined);
  assert.equal(h.fromPartition('persist:space-preview-example').webRequest.beforeRequest, undefined);
  for (const partition of [BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION]) {
    const panel = h.fromPartition(partition);
    assert.equal(panel.devicePermission(), false);
    assert.equal(panel.checkPermission({ isFocused: () => true }, 'media', 'https://public.example'), false);
    let granted;
    panel.requestPermission({ isFocused: () => true }, 'geolocation', (value) => { granted = value; }, {});
    assert.equal(granted, false);
  }
  for (const type of ['mainFrame', 'subFrame', 'image', 'script', 'xhr', 'webSocket', 'other']) {
    assert.equal(h.cancel('https://front.example/api/config/settings', type), true);
    assert.equal(h.cancel('wss://front.example/api/event/ws', type), true);
    assert.equal(h.cancel('https://public.example', type), false);
  }
});

test('main uses current settings, live tunnel, runtime windows, local server and interfaces on each request', () => {
  const h = harness();
  for (const url of ['http://127.1:3901', 'http://192.168.1.10:3901', 'https://window.example', 'https://env.example', 'https://tunnel.example', 'http://10.0.0.5:7000']) assert.equal(h.cancel(url), true, url);
  assert.equal(h.cancel('https://new.example'), false);
  h.setSettings({ desktopHosts: [{ url: 'https://new.example', apiUrl: 'https://new-api.example' }], desktopLocalPort: 4900, managedRemoteTunnelPresets: [{ hostname: 'saved-tunnel.example' }] });
  h.setTunnelUrl('https://new-tunnel.example');
  h.window.__ocRuntimeConfig.apiBaseUrl = 'https://changed-window.example';
  for (const url of ['https://new.example', 'https://new-api.example', 'https://new-tunnel.example', 'https://saved-tunnel.example', 'https://changed-window.example', 'http://[::ffff:7f00:1]:4900']) assert.equal(h.cancel(url), true, url);
  h.setReadError(new Error('settings unavailable'));
  assert.equal(h.cancel('https://public.example'), true);
});

test('webview attachment accepts the exact agent partition and rejects lookalikes', () => {
  const handlers = {};
  const guard = vm.runInNewContext(`${declaration('guardAttachedWebviews')}\nguardAttachedWebviews;`, { ...shared, currentAgentBrowserPolicy: () => buildAgentBrowserPolicy(), log: { warn() {} } });
  guard({ on: (event, handler) => { handlers[event] = handler; } });
  for (const partition of [BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION, `${AGENT_BROWSER_PARTITION}-other`, '']) {
    let prevented = false;
    const preferences = { partition, preload: '/unsafe.cjs', nodeIntegration: true };
    handlers['will-attach-webview']({ preventDefault: () => { prevented = true; } }, preferences, {});
    assert.equal(prevented, !isStandaloneBrowserPanelPartition(partition), partition);
    assert.equal(preferences.preload, undefined);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
  }
  let prevented = false;
  handlers['will-attach-webview']({ preventDefault: () => { prevented = true; } }, { partition: AGENT_BROWSER_PARTITION }, { src: 'chrome://settings' });
  assert.equal(prevented, true);
});

test('clear-data, capture and favicon use the agent session without accessing app or space storage', async () => {
  const h = harness();
  const writes = [];
  const fetches = [];
  const views = new Map();
  for (const [id, partition] of [[1, BROWSER_PANEL_PARTITION], [2, AGENT_BROWSER_PARTITION]]) {
    const panel = h.fromPartition(partition);
    panel.clearStorageData = async () => { writes.push(partition); };
    panel.clearCache = async () => {};
    panel.fetch = async (url) => {
      fetches.push(partition);
      if (partition === AGENT_BROWSER_PARTITION && h.cancel(url)) throw new Error('blocked');
      return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => new Uint8Array([1]).buffer };
    };
    views.set(id, { session: panel, isDestroyed: () => false, capturePage: async () => ({ toJPEG: () => Buffer.from('image'), getSize: () => ({ width: 10, height: 10 }) }) });
  }
  const isPanelSession = (candidate) => h.context.panelSessions.has(candidate);
  const resolve = vm.runInNewContext(`${declaration('resolveBrowserPanelContents')}\nresolveBrowserPanelContents;`, {
    webContents: { fromId: (id) => views.get(id) }, isPanelSession,
  });
  const invoke = vm.runInNewContext(`${declaration('handleInvoke')}\nhandleInvoke;`, {
    ...shared, session: h.context.session, resolveBrowserPanelContents: resolve,
    FAVICON_MIME_TYPES: new Set(['image/png']), MAX_FAVICON_BYTES: 512 * 1024, Buffer, URL,
  });
  for (const partition of [BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION]) await invoke(null, 'desktop_browser_clear_data', { partition, cookies: true });
  assert.deepEqual(writes, [BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION]);
  for (const partition of [`${AGENT_BROWSER_PARTITION}-other`, ` ${AGENT_BROWSER_PARTITION}`, 'persist:openchamber-agent', '']) await assert.rejects(invoke(null, 'desktop_browser_clear_data', { partition, cookies: true }), /Unsupported browser partition/);
  assert.equal((await invoke(null, 'desktop_browser_capture_page', { webContentsId: 2 })).width, 10);
  assert.match((await invoke(null, 'desktop_browser_fetch_favicon', { webContentsId: 2, url: 'https://public.example/icon.png' })).dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(invoke(null, 'desktop_browser_fetch_favicon', { webContentsId: 2, url: 'https://front.example/icon.png' }), /blocked/);
  await invoke(null, 'desktop_browser_fetch_favicon', { webContentsId: 1, url: 'https://front.example/icon.png' });
  assert.deepEqual(fetches, [AGENT_BROWSER_PARTITION, AGENT_BROWSER_PARTITION, BROWSER_PANEL_PARTITION]);
  views.set(3, { session: {}, isDestroyed: () => false });
  await assert.rejects(invoke(null, 'desktop_browser_capture_page', { webContentsId: 3 }), /not a browser panel page/);
});

test('agent links remain in their own view while human popups keep their existing behavior', () => {
  const h = harness();
  let created;
  const loads = [];
  const start = main.indexOf("app.on('web-contents-created',");
  const end = main.indexOf('\n// All desktop_* IPC', start);
  vm.runInNewContext(main.slice(start, end), {
    ...shared, session: h.context.session, app: { on: (_event, handler) => { created = handler; } },
    currentAgentBrowserPolicy: () => buildAgentBrowserPolicy({ serverUrls: ['https://front.example'] }),
    browserPanelWindowOpenTarget, BrowserWindow: { fromWebContents: () => null },
    BROWSER_PANEL_POPUP_WEB_PREFERENCES: {},
    loadUrlInsideWebContents: (contents, url) => loads.push({ contents, url }),
  });
  for (const partition of [AGENT_BROWSER_PARTITION, BROWSER_PANEL_PARTITION]) {
    let open;
    const handlers = {};
    const contents = { getType: () => 'webview', session: h.fromPartition(partition), setWindowOpenHandler: (handler) => { open = handler; }, on: (event, handler) => { handlers[event] = handler; } };
    created(null, contents);
    assert.equal(open({ url: 'https://public.example/login', disposition: 'new-window' }).action, partition === AGENT_BROWSER_PARTITION ? 'deny' : 'allow');
    if (partition === AGENT_BROWSER_PARTITION) {
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        for (const url of ['chrome://settings', 'file:///etc/passwd', 'https://front.example', 'https://public.example']) {
          let prevented = false;
          const details = { url, isMainFrame: false, preventDefault: () => { prevented = true; } };
          if (event === 'will-frame-navigate') handlers[event](details);
          else handlers[event](details, url);
          assert.equal(prevented, url !== 'https://public.example', url);
        }
      }
    } else {
      assert.equal(handlers['will-navigate'], undefined);
    }
  }
  assert.equal(loads.length, 1);
  assert.equal(loads[0].contents.session, h.fromPartition(AGENT_BROWSER_PARTITION));
});

test('quit flushes human and agent persistent storage without copying app cookies', async () => {
  const kept = [];
  const flushed = [];
  const panels = new Map([BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION].map((partition) => [partition, {
    cookies: { partition, flushStore: async () => { flushed.push(`${partition}:cookies`); } },
    flushStorageData: () => { flushed.push(partition); },
  }]));
  const flush = vm.runInNewContext(`${declaration('flushRendererStorage')}\nflushRendererStorage;`, {
    ...shared, BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: (partition) => panels.get(partition), defaultSession: { flushStorageData: () => { flushed.push('app'); } } },
    keepSessionCookies: async (cookies) => { kept.push(cookies.partition); },
    setTimeout() {}, RENDERER_STORAGE_FLUSH_TIMEOUT_MS: 500, log: { warn() {} },
  });
  await flush();
  assert.deepEqual(kept, [BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION]);
  assert.deepEqual(new Set(flushed), new Set(['app', BROWSER_PANEL_PARTITION, AGENT_BROWSER_PARTITION, `${BROWSER_PANEL_PARTITION}:cookies`, `${AGENT_BROWSER_PARTITION}:cookies`]));
});
