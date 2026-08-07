import { WebSocketServer } from 'ws';
import {
  BROWSER_WS_MAX_PAYLOAD_BYTES,
  BROWSER_WS_PATH,
  createBrowserWsControlFrame,
  parseBrowserWsRequestPathname,
  readBrowserWsControlFrame,
} from './browser-ws-protocol.js';
import { connectCdp as defaultConnectCdp } from './cdp.js';
import {
  buildChromeLaunchArgs,
  findBrowserExecutable as defaultFindBrowserExecutable,
  killChromeProcess,
  launchChrome as defaultLaunchChrome,
} from './chrome.js';
import { keyEventsForCombo, parseKeyCombo } from './input.js';
import { normalizeBrowserUrl } from './urls.js';

const MAX_TABS = 8;
const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const NAVIGATION_TIMEOUT_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 200;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_RECORDING_FRAMES = 600;
const MAX_RECORDING_BYTES = 96 * 1024 * 1024;
const SCREENCAST_QUALITY = 70;
const IDLE_SHUTDOWN_MS = 15 * 60 * 1000;

// Named responsive presets the UI exposes; width/height drive both the emulated
// device metrics and the screencast bounds so the preview matches the surface.
const BROWSER_VIEWPORT_PRESETS = Object.freeze({
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
});

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

const nonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const resolveViewport = (input = {}) => {
  const preset = nonEmptyString(input.preset);
  if (preset && Object.hasOwn(BROWSER_VIEWPORT_PRESETS, preset)) {
    return { ...BROWSER_VIEWPORT_PRESETS[preset], preset };
  }
  const base = DEFAULT_VIEWPORT;
  return {
    preset: 'custom',
    width: clampInt(input.width, 320, 3840, base.width),
    height: clampInt(input.height, 320, 2160, base.height),
    deviceScaleFactor: clampInt(input.deviceScaleFactor, 1, 3, base.deviceScaleFactor),
    mobile: input.mobile === true,
  };
};

export const createBrowserRuntime = ({
  fs,
  fsPromises,
  path,
  spawn,
  crypto,
  dataDir,
  searchPathFor,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  env = process.env,
  now = Date.now,
  connectCdp = defaultConnectCdp,
  findBrowserExecutable = defaultFindBrowserExecutable,
  launchChrome = defaultLaunchChrome,
  idleShutdownMs = IDLE_SHUTDOWN_MS,
}) => {
  const artifactsDir = path.join(dataDir, 'browser', 'artifacts');
  const profileDir = path.join(dataDir, 'browser', 'profile');
  const tabs = new Map();
  const connections = new Set();
  let browser = null;
  let browserPromise = null;
  let activeTabId = null;
  let recording = null;
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: BROWSER_WS_MAX_PAYLOAD_BYTES });
  let idleTimer = null;

  const isConfigured = () => Boolean(findBrowserExecutable({ fs, path, env, searchPathFor }));

  const serializeTab = (tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    loading: tab.loading,
    viewport: { ...tab.viewport },
    cursor: { ...tab.cursor },
    createdAt: tab.createdAt,
  });

  const serializeRecording = () => (recording
    ? { tabId: recording.tabId, active: true, startedAt: recording.startedAt, frameCount: recording.frames.length }
    : null);

  const state = () => ({
    supported: isConfigured(),
    running: Boolean(browser),
    activeTabId,
    tabs: [...tabs.values()].map(serializeTab),
    recording: serializeRecording(),
  });

  const send = (socket, message) => {
    if (socket?.readyState !== 1) return;
    try {
      socket.send(createBrowserWsControlFrame(message), { binary: true });
    } catch {
      // socket closed between the check and the send
    }
  };

  const broadcast = (message, predicate) => {
    for (const connection of connections) {
      if (predicate && !predicate(connection)) continue;
      send(connection.socket, message);
    }
  };

  const broadcastState = () => broadcast({ t: 'state', state: state() });

  const scheduleIdleShutdown = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (tabs.size === 0 && connections.size === 0) void closeBrowser();
    }, idleShutdownMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  const handleTargetEvent = (method, params, sessionId) => {
    const tab = sessionId ? [...tabs.values()].find((entry) => entry.sessionId === sessionId) : null;
    if (!tab) return;
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      tab.url = params.frame?.url || tab.url;
      tab.loading = true;
      broadcast({ t: 'tab', tab: serializeTab(tab) });
      return;
    }
    if (method === 'Page.lifecycleEvent' && params.name === 'networkAlmostIdle') {
      tab.loading = false;
      broadcast({ t: 'tab', tab: serializeTab(tab) });
      return;
    }
    if (method === 'Page.loadEventFired') {
      tab.loading = false;
      void refreshTabTitle(tab);
      return;
    }
    if (method === 'Page.screencastFrame') {
      void browser?.connection.send('Page.screencastFrameAck', { sessionId: params.sessionId }, tab.sessionId).catch(() => {});
      recordFrame(tab, params.data);
      broadcast({ t: 'frame', tabId: tab.id, data: params.data, metadata: params.metadata }, (connection) => connection.watching === tab.id);
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map((arg) => (arg?.value !== undefined ? String(arg.value) : arg?.description || '')).join(' ');
      broadcast({ t: 'console', tabId: tab.id, level: params.type, text }, (connection) => connection.watching === tab.id);
    }
  };

  const ensureBrowser = async () => {
    if (browser) return browser;
    if (browserPromise) return browserPromise;
    browserPromise = (async () => {
      const executable = findBrowserExecutable({ fs, path, env, searchPathFor });
      if (!executable) {
        throw new Error('No Chrome-compatible browser was found. Install Chrome/Chromium or set OPENCHAMBER_BROWSER_PATH.');
      }
      const launched = await launchChrome({ fsPromises, path, spawn, executable, profileDir, env });
      const connection = await connectCdp(launched.webSocketDebuggerUrl);
      connection.onEvent(handleTargetEvent);
      connection.onClose(() => {
        if (browser?.connection === connection) handleBrowserGone();
      });
      await connection.send('Target.setDiscoverTargets', { discover: true });
      browser = { process: launched.process, connection, executable };
      broadcastState();
      return browser;
    })().finally(() => {
      browserPromise = null;
    });
    return browserPromise;
  };

  const handleBrowserGone = () => {
    const hadBrowser = Boolean(browser);
    browser = null;
    tabs.clear();
    activeTabId = null;
    recording = null;
    if (hadBrowser) broadcastState();
  };

  const closeBrowser = async () => {
    const current = browser;
    browser = null;
    tabs.clear();
    activeTabId = null;
    recording = null;
    if (current) {
      try {
        current.connection.close();
      } catch {
        // connection may already be gone
      }
      killChromeProcess(current.process);
    }
    broadcastState();
  };

  const refreshTabTitle = async (tab) => {
    if (!browser) return;
    try {
      const result = await browser.connection.send('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      }, tab.sessionId);
      const title = nonEmptyString(result?.result?.value);
      if (title && title !== tab.title) {
        tab.title = title;
        broadcast({ t: 'tab', tab: serializeTab(tab) });
      }
    } catch {
      // navigation may have replaced the execution context
    }
  };

  const applyViewport = async (tab) => {
    await browser.connection.send('Emulation.setDeviceMetricsOverride', {
      width: tab.viewport.width,
      height: tab.viewport.height,
      deviceScaleFactor: tab.viewport.deviceScaleFactor,
      mobile: tab.viewport.mobile,
    }, tab.sessionId);
  };

  const startScreencastIfWatched = async (tab) => {
    if (!browser) return;
    const watched = [...connections].some((connection) => connection.watching === tab.id);
    if (watched === tab.screencasting) return;
    tab.screencasting = watched;
    try {
      if (watched) {
        await browser.connection.send('Page.startScreencast', {
          format: 'jpeg',
          quality: SCREENCAST_QUALITY,
          maxWidth: tab.viewport.width,
          maxHeight: tab.viewport.height,
          everyNthFrame: 1,
        }, tab.sessionId);
      } else if (!recording || recording.tabId !== tab.id) {
        await browser.connection.send('Page.stopScreencast', {}, tab.sessionId);
      }
    } catch {
      tab.screencasting = false;
    }
  };

  const requireTab = (tabId) => {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) throw new Error('Browser tab not found');
    return tab;
  };

  const createTab = async (params = {}) => {
    if (tabs.size >= MAX_TABS) throw new Error(`Maximum of ${MAX_TABS} browser tabs reached`);
    const resolvedViewport = resolveViewport(params.viewport || params);
    const url = params.url;
    await ensureBrowser();
    // Viewport is driven by Emulation.setDeviceMetricsOverride; passing
    // width/height to createTarget requires a new OS window (rejected in
    // headless with "Target position can only be set for new windows").
    const { targetId } = await browser.connection.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await browser.connection.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = {
      id: targetId,
      sessionId,
      title: '',
      url: 'about:blank',
      loading: false,
      viewport: resolvedViewport,
      cursor: { x: Math.round(resolvedViewport.width / 2), y: Math.round(resolvedViewport.height / 2), visible: false },
      createdAt: now(),
      screencasting: false,
    };
    tabs.set(targetId, tab);
    activeTabId = targetId;
    await browser.connection.send('Page.enable', {}, sessionId);
    await browser.connection.send('Runtime.enable', {}, sessionId);
    await browser.connection.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {});
    await applyViewport(tab);
    if (nonEmptyString(url)) await navigate({ tabId: targetId, url });
    broadcastState();
    return serializeTab(tab);
  };

  const ensureActiveTab = async () => {
    if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
    if (tabs.size > 0) {
      activeTabId = [...tabs.keys()][tabs.size - 1];
      return tabs.get(activeTabId);
    }
    await createTab({});
    return tabs.get(activeTabId);
  };

  const navigate = async ({ tabId, url }) => {
    const normalized = normalizeBrowserUrl(url);
    if (!normalized.ok) throw new Error(normalized.error);
    const tab = tabId ? requireTab(tabId) : await ensureActiveTab();
    activeTabId = tab.id;
    tab.loading = true;
    tab.url = normalized.url;
    broadcast({ t: 'tab', tab: serializeTab(tab) });
    const loaded = waitForLoad(tab);
    await browser.connection.send('Page.navigate', { url: normalized.url }, tab.sessionId);
    await loaded;
    await refreshTabTitle(tab);
    return serializeTab(tab);
  };

  const waitForLoad = (tab) => new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(), NAVIGATION_TIMEOUT_MS);
    const dispose = browser.connection.onEvent((method, _params, sessionId) => {
      if (sessionId === tab.sessionId && (method === 'Page.loadEventFired')) finish();
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      dispose();
      tab.loading = false;
      resolve();
    };
  });

  const setViewport = async ({ tabId, viewport, ...rest }) => {
    const tab = requireTab(tabId);
    tab.viewport = resolveViewport(viewport || rest);
    await applyViewport(tab);
    if (tab.screencasting) {
      await browser.connection.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
      tab.screencasting = false;
      await startScreencastIfWatched(tab);
    }
    broadcast({ t: 'tab', tab: serializeTab(tab) });
    return serializeTab(tab);
  };

  const updateCursor = (tab, x, y, visible = true) => {
    tab.cursor = { x: Math.round(x), y: Math.round(y), visible };
    broadcast({ t: 'cursor', tabId: tab.id, cursor: { ...tab.cursor } });
  };

  const dispatchMouse = async (tab, type, x, y, extra = {}) => {
    await browser.connection.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: extra.button || 'none',
      buttons: extra.buttons || 0,
      clickCount: extra.clickCount || 0,
      ...(extra.deltaX !== undefined ? { deltaX: extra.deltaX } : {}),
      ...(extra.deltaY !== undefined ? { deltaY: extra.deltaY } : {}),
    }, tab.sessionId);
  };

  const click = async ({ tabId, x, y }) => {
    const tab = requireTab(tabId);
    const px = clampInt(x, 0, tab.viewport.width, 0);
    const py = clampInt(y, 0, tab.viewport.height, 0);
    await dispatchMouse(tab, 'mouseMoved', px, py);
    await dispatchMouse(tab, 'mousePressed', px, py, { button: 'left', buttons: 1, clickCount: 1 });
    await dispatchMouse(tab, 'mouseReleased', px, py, { button: 'left', buttons: 1, clickCount: 1 });
    updateCursor(tab, px, py, true);
    return serializeTab(tab);
  };

  const move = async ({ tabId, x, y }) => {
    const tab = requireTab(tabId);
    const px = clampInt(x, 0, tab.viewport.width, 0);
    const py = clampInt(y, 0, tab.viewport.height, 0);
    await dispatchMouse(tab, 'mouseMoved', px, py);
    updateCursor(tab, px, py, true);
    return serializeTab(tab);
  };

  const scroll = async ({ tabId, x, y, deltaX = 0, deltaY = 0 }) => {
    const tab = requireTab(tabId);
    const px = clampInt(x ?? tab.cursor.x, 0, tab.viewport.width, tab.cursor.x);
    const py = clampInt(y ?? tab.cursor.y, 0, tab.viewport.height, tab.cursor.y);
    await dispatchMouse(tab, 'mouseWheel', px, py, {
      deltaX: clampInt(deltaX, -10_000, 10_000, 0),
      deltaY: clampInt(deltaY, -10_000, 10_000, 0),
    });
    return serializeTab(tab);
  };

  const type = async ({ tabId, text }) => {
    const tab = requireTab(tabId);
    if (typeof text !== 'string' || text.length === 0) throw new Error('text is required');
    if (text.length > 10_000) throw new Error('text is too long');
    await browser.connection.send('Input.insertText', { text }, tab.sessionId);
    return serializeTab(tab);
  };

  const pressKey = async ({ tabId, key }) => {
    const tab = requireTab(tabId);
    const parsed = parseKeyCombo(key);
    if (!parsed) throw new Error(`Unsupported key: ${key}`);
    for (const event of keyEventsForCombo(parsed)) {
      await browser.connection.send('Input.dispatchKeyEvent', event, tab.sessionId);
    }
    return serializeTab(tab);
  };

  const evaluate = async ({ tabId, expression }) => {
    const tab = requireTab(tabId);
    if (!nonEmptyString(expression)) throw new Error('expression is required');
    const result = await browser.connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: MAX_WAIT_TIMEOUT_MS,
    }, tab.sessionId);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed');
    }
    return { value: result?.result?.value ?? null };
  };

  const waitFor = async ({ tabId, selector, expression, timeout }) => {
    const tab = requireTab(tabId);
    const timeoutMs = clampInt(timeout, 100, MAX_WAIT_TIMEOUT_MS, 10_000);
    const probe = nonEmptyString(expression)
      ? `Boolean(${expression})`
      : nonEmptyString(selector)
        ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        : null;
    if (!probe) throw new Error('selector or expression is required');
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const result = await browser.connection.send('Runtime.evaluate', {
        expression: probe,
        returnByValue: true,
      }, tab.sessionId).catch(() => null);
      if (result?.result?.value === true) return { matched: true };
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for condition');
  };

  const writeArtifact = async (buffer, extension, meta) => {
    await fsPromises.mkdir(artifactsDir, { recursive: true });
    const id = `${now()}-${crypto.randomBytes(6).toString('hex')}`;
    const fileName = `${id}.${extension}`;
    await fsPromises.writeFile(path.join(artifactsDir, fileName), buffer, { mode: 0o600 });
    return { id: fileName, createdAt: now(), bytes: buffer.byteLength, ...meta };
  };

  const screenshot = async ({ tabId, fullPage } = {}) => {
    const tab = requireTab(tabId);
    const result = await browser.connection.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage === true,
      ...(fullPage === true ? { clip: undefined } : {}),
    }, tab.sessionId);
    if (!result?.data) throw new Error('Screenshot capture failed');
    const buffer = Buffer.from(result.data, 'base64');
    const artifact = await writeArtifact(buffer, 'png', { kind: 'screenshot', tabId: tab.id, url: tab.url });
    broadcast({ t: 'artifact', artifact });
    return artifact;
  };

  const recordFrame = (tab, base64Data) => {
    if (!recording || recording.tabId !== tab.id) return;
    const buffer = Buffer.from(base64Data, 'base64');
    recording.bytes += buffer.byteLength;
    recording.frames.push({ timestamp: now() - recording.startedAt, data: base64Data });
    if (recording.frames.length > MAX_RECORDING_FRAMES || recording.bytes > MAX_RECORDING_BYTES) {
      void stopRecording();
    }
  };

  const startRecording = async ({ tabId } = {}) => {
    const tab = requireTab(tabId);
    if (recording) throw new Error('A recording is already in progress');
    recording = { tabId: tab.id, startedAt: now(), frames: [], bytes: 0, viewport: { ...tab.viewport } };
    if (!tab.screencasting) {
      await browser.connection.send('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        maxWidth: tab.viewport.width,
        maxHeight: tab.viewport.height,
        everyNthFrame: 1,
      }, tab.sessionId);
    }
    broadcast({ t: 'recording', recording: serializeRecording() });
    return serializeRecording();
  };

  const stopRecording = async () => {
    if (!recording) throw new Error('No recording is in progress');
    const finished = recording;
    recording = null;
    const tab = tabs.get(finished.tabId);
    if (tab && !tab.screencasting && browser) {
      await browser.connection.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
    }
    const manifest = {
      kind: 'recording',
      viewport: finished.viewport,
      durationMs: now() - finished.startedAt,
      frames: finished.frames,
    };
    const buffer = Buffer.from(JSON.stringify(manifest), 'utf8');
    const artifact = await writeArtifact(buffer, 'ocbrec.json', {
      kind: 'recording',
      tabId: finished.tabId,
      frameCount: finished.frames.length,
      durationMs: manifest.durationMs,
    });
    broadcast({ t: 'recording', recording: null });
    broadcast({ t: 'artifact', artifact });
    return artifact;
  };

  const closeTab = async ({ tabId }) => {
    const tab = requireTab(tabId);
    if (recording?.tabId === tab.id) await stopRecording().catch(() => {});
    tabs.delete(tab.id);
    if (activeTabId === tab.id) activeTabId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
    if (browser) await browser.connection.send('Target.closeTarget', { targetId: tab.id }).catch(() => {});
    for (const connection of connections) {
      if (connection.watching === tab.id) connection.watching = null;
    }
    if (tabs.size === 0) scheduleIdleShutdown();
    broadcastState();
    return { closed: true };
  };

  const selectTab = ({ tabId }) => {
    const tab = requireTab(tabId);
    activeTabId = tab.id;
    broadcastState();
    return serializeTab(tab);
  };

  // Single dispatch surface shared by HTTP routes, the WebSocket input channel,
  // and the agent tool, so every entrypoint honors the same validation.
  const executeAction = async (action, params = {}) => {
    switch (action) {
      case 'state':
        return state();
      case 'tab.create':
        return { tab: await createTab(params) };
      case 'tab.close':
        return closeTab(params);
      case 'tab.select':
        return { tab: selectTab(params) };
      case 'navigate':
        return { tab: await navigate(params) };
      case 'click':
        return { tab: await click(params) };
      case 'move':
        return { tab: await move(params) };
      case 'scroll':
        return { tab: await scroll(params) };
      case 'type':
        return { tab: await type(params) };
      case 'key':
        return { tab: await pressKey(params) };
      case 'evaluate':
        return evaluate(params);
      case 'wait':
        return waitFor(params);
      case 'viewport':
        return { tab: await setViewport(params) };
      case 'screenshot':
        return { artifact: await screenshot(params) };
      case 'recording.start':
        return { recording: await startRecording(params) };
      case 'recording.stop':
        return { artifact: await stopRecording() };
      default:
        throw new Error(`Unsupported browser action: ${action || 'missing'}`);
    }
  };

  const listArtifacts = async () => {
    const entries = await fsPromises.readdir(artifactsDir).catch(() => []);
    const artifacts = [];
    for (const name of entries) {
      const stats = await fsPromises.stat(path.join(artifactsDir, name)).catch(() => null);
      if (!stats?.isFile()) continue;
      artifacts.push({
        id: name,
        kind: name.endsWith('.ocbrec.json') ? 'recording' : 'screenshot',
        bytes: stats.size,
        createdAt: Math.round(stats.mtimeMs),
      });
    }
    return artifacts.sort((left, right) => right.createdAt - left.createdAt);
  };

  const readArtifact = async (id) => {
    if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || id.includes('..')) return null;
    const filePath = path.join(artifactsDir, id);
    if (!filePath.startsWith(artifactsDir)) return null;
    const buffer = await fsPromises.readFile(filePath).catch(() => null);
    if (!buffer) return null;
    const contentType = id.endsWith('.png')
      ? 'image/png'
      : id.endsWith('.ocbrec.json')
        ? 'application/json'
        : 'application/octet-stream';
    return { buffer, contentType };
  };

  const attachConnection = (socket) => {
    const connection = { socket, watching: null };
    connections.add(connection);
    send(socket, { t: 'snapshot', state: state() });
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      const message = readBrowserWsControlFrame(raw);
      if (!message || typeof message.t !== 'string') return;
      void handleClientMessage(connection, message);
    });
    const cleanup = () => {
      connections.delete(connection);
      if (connection.watching) {
        const tab = tabs.get(connection.watching);
        if (tab) void startScreencastIfWatched(tab);
      }
      if (connections.size === 0 && tabs.size === 0) scheduleIdleShutdown();
    };
    socket.on('close', cleanup);
    socket.on('error', () => {});
  };

  const handleClientMessage = async (connection, message) => {
    if (message.t === 'ping') {
      send(connection.socket, { t: 'pong' });
      return;
    }
    if (message.t === 'watch') {
      const previous = connection.watching;
      connection.watching = typeof message.tabId === 'string' ? message.tabId : null;
      if (previous && previous !== connection.watching) {
        const previousTab = tabs.get(previous);
        if (previousTab) await startScreencastIfWatched(previousTab);
      }
      const tab = connection.watching ? tabs.get(connection.watching) : null;
      if (tab) await startScreencastIfWatched(tab);
      return;
    }
    if (message.t === 'unwatch') {
      const previous = connection.watching;
      connection.watching = null;
      if (previous) {
        const tab = tabs.get(previous);
        if (tab) await startScreencastIfWatched(tab);
      }
      return;
    }
    if (message.t === 'input' && nonEmptyString(message.action)) {
      try {
        await executeAction(message.action, message.params || {});
      } catch (error) {
        send(connection.socket, { t: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const attachWebSocket = (server) => {
    wsServer.on('connection', (socket) => attachConnection(socket));
    const upgradeHandler = (req, socket, head) => {
      if (parseBrowserWsRequestPathname(req.url) !== BROWSER_WS_PATH) return;
      void (async () => {
        try {
          if (uiAuthController?.enabled) {
            if (!await uiAuthController.ensureSessionToken(req, null)) {
              rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
              return;
            }
            if (!await isRequestOriginAllowed(req)) {
              rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
              return;
            }
          }
          if (!wsServer) {
            rejectWebSocketUpgrade(socket, 500, 'Browser WebSocket unavailable');
            return;
          }
          wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
        } catch {
          rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
        }
      })();
    };
    server.on('upgrade', upgradeHandler);
    return () => server.off('upgrade', upgradeHandler);
  };

  const shutdown = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    await closeBrowser();
    if (!wsServer) return;
    for (const client of wsServer.clients) {
      try {
        client.terminate();
      } catch {
        // already gone
      }
    }
    await Promise.race([
      new Promise((resolve) => wsServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    wsServer = null;
  };

  return {
    isConfigured,
    state,
    executeAction,
    listArtifacts,
    readArtifact,
    attachWebSocket,
    shutdown,
    // Exposed for focused tests.
    _internal: { resolveViewport, createTab, buildChromeLaunchArgs },
  };
};
