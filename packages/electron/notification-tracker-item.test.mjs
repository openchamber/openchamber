import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrackerItemClicks } from './notification-tracker-item.mjs';

const fakeWindow = (id) => ({ id, __ocRuntimeKey: 'local', isDestroyed: () => false, isMinimized: () => false, restore() {}, focus() {} });

const setup = ({ main = null, ready = true } = {}) => {
  let clock = 1_000;
  const emitted = [];
  const opened = [];
  const state = { main };
  const clicks = createTrackerItemClicks({
    app: { focus() {} }, getMainWindow: () => state.main, showWindow() {}, emitToWindow: (window, event, detail) => emitted.push({ window: window?.id, event, detail }),
    openMainWindow: async () => { state.main = fakeWindow(1); opened.push('main'); }, openHostWindow: async () => {}, hostRoutingContext: () => ({ hosts: [] }),
    isMainWindowReady: () => ready, log: { warn() {} }, now: () => clock,
  });
  return { clicks, emitted, opened, state, advance: (ms) => { clock += ms; } };
};

const pull = { itemUrl: 'https://github.com/acme/app/pull/7', directory: '/work/app', runtimeKey: 'local' };

test('a click tells the main window that a pull request waits, and the window takes it once', async () => {
  const { clicks, emitted, state } = setup({ main: fakeWindow(1) });
  let released = false;
  assert.equal(clicks.openFromNotification(pull, () => { released = true; }), true);
  await new Promise(setImmediate);
  assert.equal(released, true);
  assert.deepEqual(emitted, [{ window: 1, event: 'openchamber:tracker-item-waiting', detail: undefined }]);
  assert.deepEqual(clicks.take(state.main), { url: pull.itemUrl, directory: '/work/app', runtimeKey: 'local' });
  assert.equal(clicks.take(state.main), null);
});

test('a click with no main window opens it, and only the main window takes the click, within a minute', async () => {
  const { clicks, opened, state, advance } = setup();
  clicks.openFromNotification(pull, () => {});
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['main']);
  assert.equal(clicks.take(fakeWindow(2)), null);
  assert.deepEqual(clicks.take(state.main), { url: pull.itemUrl, directory: '/work/app', runtimeKey: 'local' });
  assert.equal(clicks.take(state.main), null);

  clicks.openFromNotification(pull, () => {});
  await new Promise(setImmediate);
  advance(60_000);
  assert.equal(clicks.take(state.main), null);
});

test('a notification without a plain web address is no tracker item click', () => {
  const { clicks } = setup({ main: fakeWindow(1) });
  let released = false;
  assert.equal(clicks.openFromNotification({ itemUrl: 'javascript:alert(1)' }, () => { released = true; }), false);
  assert.equal(released, false);
});

test('a click while the main view remounts reaches the listener that mounts next', async () => {
  const { clicks, state } = setup({ main: fakeWindow(1) });
  clicks.take(state.main);
  clicks.openFromNotification(pull, () => {});
  await new Promise(setImmediate);
  assert.deepEqual(clicks.take(state.main), { url: pull.itemUrl, directory: '/work/app', runtimeKey: 'local' });
  assert.equal(clicks.take(state.main), null);
});

test('a click while the main window loads is not offered to the page that is leaving, and the next page takes it', async () => {
  const { clicks, emitted, state } = setup({ main: fakeWindow(1), ready: false });
  clicks.openFromNotification(pull, () => {});
  await new Promise(setImmediate);
  assert.deepEqual(emitted, []);
  assert.deepEqual(clicks.take(state.main), { url: pull.itemUrl, directory: '/work/app', runtimeKey: 'local' });
});
