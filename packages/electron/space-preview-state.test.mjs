import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpacePreviewState } from './space-preview-state.mjs';

const SPACE_A = 'aaaaaaaaaaaa';
const SPACE_B = 'bbbbbbbbbbbb';

const harness = () => {
  const applied = [];
  const released = [];
  const proxyErrors = [];
  const state = createSpacePreviewState({
    applyProxy: async (spaceId, localPorts) => {
      applied.push({ spaceId, localPorts });
    },
    releaseSpace: (spaceId) => {
      released.push(spaceId);
    },
    onProxyError: (spaceId, error) => {
      proxyErrors.push({ spaceId, error });
    },
  });
  return { state, applied, released, proxyErrors };
};

test('preview-open applies the proxy with the opened port and tracks the entry', async () => {
  const { state, applied } = harness();
  await state.openPort(SPACE_A, 4101);
  assert.deepEqual(applied, [{ spaceId: SPACE_A, localPorts: [4101] }]);
  assert.equal(state.has(SPACE_A), true);
  assert.deepEqual(state.portsOf(SPACE_A), [4101]);
  assert.equal(state.size, 1);
});

test('closing the only port re-applies an empty proxy but keeps the entry until teardown', async () => {
  const { state, applied, released } = harness();
  await state.openPort(SPACE_A, 4101);
  await state.closePort(SPACE_A, 4101);
  assert.deepEqual(applied.at(-1), { spaceId: SPACE_A, localPorts: [] });
  assert.equal(state.has(SPACE_A), true);
  assert.deepEqual(released, []);
});

test('teardown after preview-close drops the entry and releases the space exactly once', async () => {
  const { state, released } = harness();
  await state.openPort(SPACE_A, 4101);
  await state.closePort(SPACE_A, 4101);
  assert.equal(await state.teardown(SPACE_A), true);
  assert.equal(state.has(SPACE_A), false);
  assert.equal(state.size, 0);
  assert.deepEqual(released, [SPACE_A]);
  assert.equal(await state.teardown(SPACE_A), false);
  assert.deepEqual(released, [SPACE_A]);
});

test('teardown waits for an in-flight proxy update before dropping state', async () => {
  const order = [];
  let unblockApply;
  const applyGate = new Promise((resolve) => {
    unblockApply = resolve;
  });
  const state = createSpacePreviewState({
    applyProxy: async () => {
      order.push('apply:start');
      await applyGate;
      order.push('apply:end');
    },
    releaseSpace: () => {
      order.push('release');
    },
  });
  const opening = state.openPort(SPACE_A, 4101);
  const tearingDown = state.teardown(SPACE_A);
  unblockApply();
  assert.equal(await tearingDown, true);
  await opening;
  assert.deepEqual(order, ['apply:start', 'apply:end', 'release']);
  assert.equal(state.size, 0);
});

test('teardown of one space leaves another live space and its ports untouched', async () => {
  const { state, released } = harness();
  await state.openPort(SPACE_A, 4101);
  await state.openPort(SPACE_B, 4202);
  assert.equal(await state.teardown(SPACE_A), true);
  assert.deepEqual(released, [SPACE_A]);
  assert.equal(state.has(SPACE_B), true);
  assert.deepEqual(state.portsOf(SPACE_B), [4202]);
  assert.equal(state.size, 1);
});

test('a space can initialize and apply its proxy normally after a teardown', async () => {
  const { state, applied, released } = harness();
  await state.openPort(SPACE_A, 4101);
  assert.equal(await state.teardown(SPACE_A), true);
  await state.prepare(SPACE_A);
  await state.openPort(SPACE_A, 4102);
  assert.deepEqual(applied.at(-1), { spaceId: SPACE_A, localPorts: [4102] });
  assert.equal(state.has(SPACE_A), true);
  assert.deepEqual(state.portsOf(SPACE_A), [4102]);
  assert.deepEqual(released, [SPACE_A]);
});

test('reopening a space while its teardown is queued keeps the fresh entry and session', async () => {
  const { state, released } = harness();
  await state.openPort(SPACE_A, 4101);
  const tearingDown = state.teardown(SPACE_A);
  await state.openPort(SPACE_A, 4103);
  assert.equal(await tearingDown, false);
  assert.equal(state.has(SPACE_A), true);
  assert.deepEqual(state.portsOf(SPACE_A), [4103]);
  assert.deepEqual(released, []);
});

test('closeAll empties every port set and reports proxy failures without throwing', async () => {
  const proxyErrors = [];
  const state = createSpacePreviewState({
    applyProxy: async (spaceId, localPorts) => {
      if (spaceId === SPACE_A && localPorts.length === 0) throw new Error('proxy reset failed');
    },
    onProxyError: (spaceId, error) => {
      proxyErrors.push({ spaceId, message: error.message });
    },
  });
  await state.openPort(SPACE_A, 4101);
  await state.openPort(SPACE_B, 4202);
  state.closeAll();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.portsOf(SPACE_A), []);
  assert.deepEqual(state.portsOf(SPACE_B), []);
  assert.deepEqual(proxyErrors, [{ spaceId: SPACE_A, message: 'proxy reset failed' }]);
});

test('a rejected proxy update does not break the chain for later updates', async () => {
  const applied = [];
  let failNext = true;
  const state = createSpacePreviewState({
    applyProxy: async (spaceId, localPorts) => {
      if (failNext) {
        failNext = false;
        throw new Error('transient proxy failure');
      }
      applied.push({ spaceId, localPorts });
    },
  });
  await assert.rejects(state.openPort(SPACE_A, 4101), /transient proxy failure/);
  await state.openPort(SPACE_A, 4102);
  assert.deepEqual(applied, [{ spaceId: SPACE_A, localPorts: [4101, 4102] }]);
});
