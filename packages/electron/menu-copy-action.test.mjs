import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopyMenuAction } from './menu-copy-action.mjs';

// Electron exposes hostWebContents as a property, not a method.
const pageContents = (hostWebContents = null) => {
  const calls = [];
  return {
    calls,
    hostWebContents,
    copy: () => calls.push('copy'),
  };
};

for (const host of [null, pageContents()]) {
  test(`DevTools with ${host ? 'a host' : 'no host'} copies without an app action`, () => {
    const appWindow = { webContents: pageContents() };
    const devtools = pageContents(host);
    const dispatches = [];
    const handleCopyAction = createCopyMenuAction({
      getFocusedWebContents: () => devtools,
      getAppWindows: () => [appWindow],
      dispatchAppCopy: (window) => dispatches.push(window),
    });

    handleCopyAction();

    assert.deepEqual(devtools.calls, ['copy']);
    assert.deepEqual(appWindow.webContents.calls, []);
    assert.deepEqual(dispatches, []);
  });
}

test('copy from an app document dispatches to that exact app window', () => {
  const mainWindow = { webContents: pageContents() };
  const miniChatWindow = { webContents: pageContents() };
  const dispatches = [];
  let focused = mainWindow.webContents;
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => focused,
    getAppWindows: () => [mainWindow, miniChatWindow],
    dispatchAppCopy: (window) => dispatches.push(window),
  });

  handleCopyAction();
  focused = miniChatWindow.webContents;
  handleCopyAction();

  assert.deepEqual(mainWindow.webContents.calls, ['copy']);
  assert.deepEqual(miniChatWindow.webContents.calls, ['copy']);
  assert.deepEqual(dispatches, [mainWindow, miniChatWindow]);
});

test('a focused browser guest copies its own selection without an app action', () => {
  const appWindow = { webContents: pageContents() };
  const guest = pageContents(appWindow.webContents);
  const dispatches = [];
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => guest,
    getAppWindows: () => [appWindow],
    dispatchAppCopy: (window) => dispatches.push(window),
  });

  handleCopyAction();

  assert.deepEqual(guest.calls, ['copy']);
  assert.deepEqual(appWindow.webContents.calls, []);
  assert.deepEqual(dispatches, []);
});

test('nothing focused copies nothing and dispatches nothing', () => {
  const appWindow = { webContents: pageContents() };
  const dispatches = [];
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => null,
    getAppWindows: () => [appWindow],
    dispatchAppCopy: (window) => dispatches.push(window),
  });

  handleCopyAction();

  assert.deepEqual(appWindow.webContents.calls, []);
  assert.deepEqual(dispatches, []);
});
