import assert from 'node:assert/strict';
import test from 'node:test';

import { createWindowGeometryState } from './window-geometry-state.mjs';
import { persistMainWindowState } from './window-state.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createFakeTimers = ({ clearable = true } = {}) => {
  let nextId = 0;
  const callbacks = new Map();
  return {
    setTimeoutFn(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) {
      if (clearable) callbacks.delete(id);
    },
    pending() {
      return [...callbacks.keys()];
    },
    async fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.();
      await flush();
    },
  };
};

const createWindow = (id) => ({ id, destroyed: false, isDestroyed() { return this.destroyed; } });

test('repeated geometry updates replace timers and only persist the latest revision', async () => {
  const fakeTimers = createFakeTimers();
  const persisted = [];
  const geometry = createWindowGeometryState({
    persist: async (window) => persisted.push(window.id),
    ...fakeTimers,
  });
  const window = createWindow(7);

  geometry.schedule(window);
  const [staleTimer] = fakeTimers.pending();
  geometry.schedule(window);
  const [latestTimer] = fakeTimers.pending();
  assert.notEqual(latestTimer, staleTimer);

  await fakeTimers.fire(latestTimer);
  assert.deepEqual(persisted, [7]);
  assert.deepEqual(fakeTimers.pending(), []);
});

test('closing with a pending timer cancels it and prevents persistence', async () => {
  const fakeTimers = createFakeTimers();
  const persisted = [];
  const geometry = createWindowGeometryState({
    persist: async (window) => persisted.push(window.id),
    ...fakeTimers,
  });
  const window = createWindow(11);

  geometry.schedule(window);
  const [timer] = fakeTimers.pending();
  window.destroyed = true;
  geometry.cancel(window);
  await fakeTimers.fire(timer);

  assert.deepEqual(persisted, []);
  assert.deepEqual(fakeTimers.pending(), []);
});

test('an older completion cannot drop a newer scheduled save', async () => {
  const fakeTimers = createFakeTimers();
  let finishFirst;
  let calls = 0;
  const geometry = createWindowGeometryState({
    persist: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve();
    },
    ...fakeTimers,
  });
  const window = createWindow(13);

  geometry.schedule(window, true);
  await flush();
  geometry.schedule(window);
  const [latestTimer] = fakeTimers.pending();
  finishFirst();
  await flush();

  await fakeTimers.fire(latestTimer);
  assert.equal(calls, 2);
});

test('a stale timer callback cannot cancel the newer timer', async () => {
  const fakeTimers = createFakeTimers({ clearable: false });
  const persisted = [];
  const geometry = createWindowGeometryState({
    persist: async (window) => persisted.push(window.id),
    ...fakeTimers,
  });
  const window = createWindow(15);

  geometry.schedule(window);
  geometry.schedule(window);
  const [staleTimer, latestTimer] = fakeTimers.pending();
  await fakeTimers.fire(staleTimer);
  assert.deepEqual(persisted, []);

  await fakeTimers.fire(latestTimer);
  assert.deepEqual(persisted, [15]);
});

test('bounds restored after a save skipped while minimized are written once the oldest write finishes', async () => {
  const fakeTimers = createFakeTimers();
  let minimized = false;
  let bounds = { x: 10, y: 10, width: 1000, height: 700 };
  const mainWindow = {
    id: 1,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    getBounds: () => bounds,
    isMaximized: () => false,
    isFullScreen: () => false,
  };
  const settings = {};
  const writes = [];
  let finishFirstWrite;
  const mutateSettingsRoot = async (mutator) => {
    writes.push(mutator);
    if (writes.length === 1) await new Promise((resolve) => { finishFirstWrite = resolve; });
    mutator(settings);
  };
  const geometry = createWindowGeometryState({
    persist: (browserWindow) => persistMainWindowState({
      browserWindow,
      mainWindowId: 1,
      quakeActive: false,
      minWidth: 800,
      minHeight: 520,
      mutateSettingsRoot,
    }),
    ...fakeTimers,
  });

  geometry.schedule(mainWindow, true);
  await flush();
  assert.equal(writes.length, 1);

  minimized = true;
  geometry.schedule(mainWindow);
  await fakeTimers.fire(fakeTimers.pending()[0]);
  assert.equal(writes.length, 1);

  minimized = false;
  bounds = { x: 50, y: 60, width: 1200, height: 800 };
  geometry.schedule(mainWindow);
  finishFirstWrite();
  await flush();

  await fakeTimers.fire(fakeTimers.pending()[0]);
  assert.equal(writes.length, 2);
  assert.deepEqual(settings.desktopWindowState, {
    x: 50, y: 60, width: 1200, height: 800, maximized: false, fullscreen: false,
  });
  assert.deepEqual(fakeTimers.pending(), []);
});
