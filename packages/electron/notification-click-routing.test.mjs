import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { findReusableHostWindowIndex, normalizeNotificationInput, parseNotificationOpenTarget, readTrimmedString, resolveHostEntryForRuntimeKey, runtimeKeyForHostUrl } from './notification-host-routing.mjs';

const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = main.indexOf(start);
  const last = main.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing main-process driver section: ${start}`);
  return main.slice(first, last);
};

// Execute the real main-process notification/window/IPC bodies without booting
// Electron or the in-process server. Only native/window boundaries are faked.
const createDriver = ({ windows = [], focused = false, packaged = false } = {}) => {
  const notifications = [];
  const emitted = [];
  const created = [];
  const navigated = [];
  const hosts = [
    { id: 'owner', url: 'https://ui.owner.test', apiUrl: 'https://api.owner.test' },
    { id: 'relay-owner', relay: { id: 'relay-owner' } },
  ];
  class NativeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
  }
  return vm.runInNewContext(`
    ${section('const activeNotifications =', 'const mapUpdaterProgressEvent =')}
    ${section('const SESSION_ROUTE_ID_RE =', '// The configured desktop host')}
    ${section('const openHostWindow =', 'const createAdditionalWindow =')}
    ({ notifications, emitted, created, navigated, hosts,
      notify: maybeShowNativeNotification,
      withRoute: withSessionRoute,
      fromUrl: sessionRouteFromUrl,
      openHost: openHostWindow,
      openTarget: async (args, browserWindow) => {
        switch ('desktop_open_host_session') {
          ${section("case 'desktop_open_host_session':", "case 'desktop_focus_main_window':")}
        }
      },
    })
  `, {
    URL, process: { platform: 'linux' }, crypto: globalThis.crypto,
    Notification: NativeNotification, notifications, emitted, created, navigated, hosts,
    normalizeNotificationInput, parseNotificationOpenTarget, readTrimmedString,
    findReusableHostWindowIndex, resolveHostEntryForRuntimeKey, runtimeKeyForHostUrl,
    BrowserWindow: { getAllWindows: () => windows },
    isAnyWindowFocused: () => focused,
    focusForegroundWindow: () => {},
    primaryEventWindow: () => windows[0] ?? null,
    showWindow: (window) => window.show(),
    emitToPrimaryWindow: (event, detail) => emitted.push({ event, detail: structuredClone(detail) }),
    emitToWindow: (window, event, detail) => emitted.push({ window, event, detail: structuredClone(detail) }),
    state: { sidecarUrl: 'http://127.0.0.1:3912', localOrigin: 'http://127.0.0.1:3912' },
    readDesktopHostsConfig: () => ({ hosts }),
    readDesktopLocalClientToken: () => '',
    shouldUsePackagedUi: () => packaged,
    buildPackagedUiUrl: () => 'openchamber-ui://app/index.html',
    normalizeHostUrl: (url) => url,
    sanitizeRuntimeRequestHeaders: (headers) => headers,
    createAdditionalWindow: async (url, config) => { created.push({ url, config: structuredClone(config) }); return {}; },
    navigateWindow: async (window, url) => navigated.push({ window, url }),
    log: { warn: () => {} },
  });
};

const botTarget = { projectId: 'project-one', itemId: 'item_one' };
const hostWindow = (id, loading = false) => ({
  __ocHostWindowId: id, __ocHostWindowBaseUrl: 'https://ui.owner.test',
  isDestroyed: () => false, isMinimized: () => false,
  show() {}, focus() {}, webContents: { isLoading: () => loading },
});

for (const sessionId of [undefined, 'ses_stage']) {
  test(`native Bot clicks emit an owned structured item with session=${sessionId}`, () => {
    const driver = createDriver();
    driver.notify({ title: 'Attention', botTarget, runtimeKey: 'host:owner', sessionId });

    driver.notifications[0].emit('click');

    assert.equal(driver.notifications[0].shown, true);
    assert.equal(driver.emitted[0].event, 'openchamber:open-session');
    assert.deepEqual(driver.emitted[0].detail.botTarget, botTarget);
    assert.equal(driver.emitted[0].detail.runtimeKey, 'host:owner');
    assert.equal(driver.emitted[0].detail.sessionId, sessionId);
  });
}

test('ordinary native session clicks retain their session, directory and guest', () => {
  const driver = createDriver();
  driver.notify({ title: 'Ready', sessionId: 'ses_one', directory: '/repo', guestId: 'browser', runtimeKey: 'local' });

  driver.notifications[0].emit('click');

  assert.deepEqual(driver.emitted[0].detail, { sessionId: 'ses_one', directory: '/repo', guestId: 'browser', runtimeKey: 'local' });
});

test('malformed item targets never emit a session fallback on native clicks', () => {
  const driver = createDriver();
  driver.notify({ title: 'Attention', botTarget: { ...botTarget, url: 'https://other.test' }, sessionId: 'ses_fallback' });

  driver.notifications[0].emit('click');

  assert.deepEqual(driver.emitted, []);
});

test('hidden-only native notifications stay suppressed while focused', () => {
  const driver = createDriver({ focused: true });

  driver.notify({ title: 'Attention', botTarget, requireHidden: true });

  assert.deepEqual(driver.notifications, []);
});

for (const packaged of [false, true]) {
  test(`foreign sessionless item IPC opens only its saved host (packaged=${packaged})`, async () => {
    const driver = createDriver({ packaged });

    const result = await driver.openTarget({ runtimeKey: 'host:owner', botTarget });

    assert.equal(result.opened, true);
    assert.equal(driver.created[0].config.apiBaseUrl, 'https://api.owner.test');
    assert.equal(driver.created[0].url, `${packaged ? 'openchamber-ui://app/index.html' : 'https://api.owner.test/'}?botsProject=project-one&botItem=item_one`);
  });
}

test('an unresolved foreign runtime cannot open a local item', async () => {
  const driver = createDriver();

  const result = await driver.openTarget({ runtimeKey: 'url:https://unknown.test', botTarget });

  assert.equal(result.opened, false);
  assert.deepEqual(driver.created, []);
  assert.deepEqual(driver.emitted, []);
});

test('the local runtime opens a sessionless item on its own backend', async () => {
  const driver = createDriver();

  await driver.openTarget({ runtimeKey: 'local', botTarget });

  assert.equal(driver.created[0].config.apiBaseUrl, 'http://127.0.0.1:3912');
  assert.equal(new URL(driver.created[0].url).searchParams.get('botItem'), botTarget.itemId);
});

test('a reused relay window receives its owning runtime rather than the active runtime', async () => {
  const window = hostWindow('relay-owner');
  const driver = createDriver({ windows: [window] });

  await driver.openTarget({ runtimeKey: 'host:relay-owner', botTarget });

  assert.deepEqual(driver.emitted[0].detail, { botTarget, runtimeKey: 'host:relay-owner' });
  assert.deepEqual(driver.created, []);
});

test('a reused direct window receives its normalized API runtime key', async () => {
  const window = hostWindow('owner');
  const driver = createDriver({ windows: [window] });

  await driver.openTarget({ runtimeKey: 'host:owner', botTarget });

  assert.deepEqual(driver.emitted[0].detail, { botTarget, runtimeKey: 'url:https://api.owner.test' });
});

test('a reused window that reported its runtime receives that same key, so it applies the item', async () => {
  // A direct host shown after an in-place switch reports `host:<id>`, which the
  // renderer compares with the key on the event before applying the item.
  const window = { ...hostWindow('other'), __ocRuntimeKey: 'host:owner' };
  const driver = createDriver({ windows: [window] });

  await driver.openTarget({ runtimeKey: 'host:owner', botTarget });

  assert.deepEqual(driver.emitted[0].detail, { botTarget, runtimeKey: 'host:owner' });
  assert.deepEqual(driver.created, []);
});

test('a same-tagged caller that switched runtimes does not receive its own foreign target again', async () => {
  // The window was opened for the owner and now reports the instance it shows.
  const window = { ...hostWindow('owner'), __ocRuntimeKey: 'local' };
  const driver = createDriver({ windows: [window] });

  await driver.openTarget({ runtimeKey: 'host:owner', botTarget }, window);

  assert.equal(driver.created.length, 1);
  assert.deepEqual(driver.emitted, []);
});

test('a booting reused window carries the item in its reload URL', async () => {
  const window = hostWindow('owner', true);
  const driver = createDriver({ windows: [window] });

  await driver.openTarget({ runtimeKey: 'host:owner', botTarget });

  assert.equal(driver.navigated[0].url, 'https://ui.owner.test/?botsProject=project-one&botItem=item_one');
});

test('item window routes replace session metadata without losing unrelated query fields', () => {
  const driver = createDriver();

  const url = new URL(driver.withRoute('https://owner.test/?session=ses_old&message=msg_old&theme=dark', { botTarget, sessionId: 'ses_stage' }));

  assert.deepEqual([...url.searchParams], [['theme', 'dark'], ['botsProject', 'project-one'], ['botItem', 'item_one']]);
});

test('ordinary session window routes replace stale Bots targets', () => {
  const driver = createDriver();

  const url = new URL(driver.withRoute('https://owner.test/?botsProject=old&botItem=old', { sessionId: 'ses_one', messageId: 'msg_one' }));

  assert.deepEqual([...url.searchParams], [['session', 'ses_one'], ['message', 'msg_one']]);
});

test('host URL parsing gives a valid item precedence over a stage session', () => {
  const driver = createDriver();

  const route = driver.fromUrl('https://owner.test/?session=ses_stage&botsProject=project-one&botItem=item_one');

  assert.deepEqual(route.botTarget, botTarget);
  assert.equal(route.sessionId, undefined);
});

test('malformed item IPC is rejected before opening a window', async () => {
  const driver = createDriver();

  await assert.rejects(driver.openTarget({ runtimeKey: 'host:owner', botTarget: { ...botTarget, itemId: '../item' }, sessionId: 'ses_fallback' }));

  assert.deepEqual(driver.created, []);
});
