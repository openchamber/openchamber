import assert from 'node:assert/strict';
import test from 'node:test';

import { createWindowGeometryState } from './window-geometry-state.mjs';

const createFakeTimers = () => {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimeoutFn(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) {
      callbacks.delete(id);
    },
    async fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.();
      await new Promise((resolve) => setImmediate(resolve));
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
  const staleTimer = geometry.timers.get('7');
  geometry.schedule(window);
  const latestTimer = geometry.timers.get('7');
  assert.notEqual(latestTimer, staleTimer);
  assert.equal(fakeTimers.callbacks.has(staleTimer), false);

  await fakeTimers.fire(latestTimer);
  assert.deepEqual(persisted, [7]);
  assert.equal(geometry.timers.has('7'), false);
  assert.equal(geometry.revisions.has('7'), false);
});

test('debounce completion releases revision and timer state', async () => {
  const fakeTimers = createFakeTimers();
  const geometry = createWindowGeometryState({ persist: async () => {}, ...fakeTimers });
  const window = createWindow(9);

  geometry.schedule(window);
  await fakeTimers.fire(geometry.timers.get('9'));

  assert.equal(geometry.timers.has('9'), false);
  assert.equal(geometry.revisions.has('9'), false);
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
  const timer = geometry.timers.get('11');
  window.destroyed = true;
  geometry.cancel(window);
  await fakeTimers.fire(timer);

  assert.deepEqual(persisted, []);
  assert.equal(geometry.timers.has('11'), false);
  assert.equal(geometry.revisions.has('11'), false);
});

test('an older completion cannot delete a newer scheduled revision', async () => {
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
  await new Promise((resolve) => setImmediate(resolve));
  geometry.schedule(window);
  const latestTimer = geometry.timers.get('13');
  finishFirst();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(geometry.revisions.has('13'), true);
  assert.equal(geometry.timers.get('13'), latestTimer);
  await fakeTimers.fire(latestTimer);
  assert.equal(geometry.revisions.has('13'), false);
});

test('a stale timer callback cannot delete the newer timer', async () => {
  const callbacks = new Map();
  let nextId = 0;
  const persisted = [];
  const geometry = createWindowGeometryState({
    persist: async (window) => persisted.push(window.id),
    setTimeoutFn(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutFn() {},
  });
  const window = createWindow(15);

  geometry.schedule(window);
  const staleTimer = geometry.timers.get('15');
  geometry.schedule(window);
  const latestTimer = geometry.timers.get('15');
  callbacks.get(staleTimer)();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(geometry.timers.get('15'), latestTimer);
  assert.deepEqual(persisted, []);
  callbacks.get(latestTimer)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persisted, [15]);
  assert.equal(geometry.revisions.has('15'), false);
});
