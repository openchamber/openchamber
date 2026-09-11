import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { attachRendererRecovery, createRendererRecoveryPolicy } from './renderer-recovery.mjs';

const createFakeWindow = () => {
  const listeners = new Map();
  const state = { reloads: 0, destroyed: false };
  const browserWindow = {
    __ocLabel: 'main',
    state,
    destroy: () => {
      state.destroyed = true;
    },
    emit: (event, details) => listeners.get(event)?.(null, details),
    isDestroyed: () => state.destroyed,
    webContents: {
      on: (event, listener) => listeners.set(event, listener),
      reload: () => {
        state.reloads += 1;
      },
    },
  };
  return browserWindow;
};

const createFakeLog = () => {
  const warnings = [];
  return { warnings, warn: (message, payload) => warnings.push({ message, payload }) };
};

test('allows a bounded number of reloads for recoverable renderer failures', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.shouldReload('crashed'), true);
  assert.equal(policy.shouldReload('oom'), true);
  assert.equal(policy.shouldReload('abnormal-exit'), true);
  assert.equal(policy.shouldReload('crashed'), false);
});

test('reloads after the renderer is evicted for memory', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.shouldReload('memory-eviction'), true);
});

test('ignores reasons Electron never reports for render-process-gone', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.shouldReload('made-up-reason'), false);
  assert.equal(policy.shouldReload('crashed'), true);
});

test('ignores clean and externally killed renderer exits', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.shouldReload('clean-exit'), false);
  assert.equal(policy.shouldReload('killed'), false);
  assert.equal(policy.shouldReload('launch-failed'), false);
});

test('resets the recovery budget after the recovery window', () => {
  let currentTime = 1_000;
  const policy = createRendererRecoveryPolicy(() => currentTime);

  assert.equal(policy.shouldReload('crashed'), true);
  assert.equal(policy.shouldReload('crashed'), true);
  assert.equal(policy.shouldReload('crashed'), true);
  assert.equal(policy.shouldReload('crashed'), false);

  currentTime += 60_000;
  assert.equal(policy.shouldReload('crashed'), true);
});

test('reloads the attached window after a recoverable renderer failure', async () => {
  const browserWindow = createFakeWindow();
  const log = createFakeLog();
  attachRendererRecovery(browserWindow, { log, label: 'mini chat' });

  browserWindow.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  await setTimeout(150);

  assert.equal(browserWindow.state.reloads, 1);
  assert.equal(log.warnings.length, 1);
  assert.equal(log.warnings[0].payload.surface, 'mini chat');
  assert.equal(log.warnings[0].payload.label, 'main');
});

test('skips the reload when the window is gone or the exit is not recoverable', async () => {
  const browserWindow = createFakeWindow();
  attachRendererRecovery(browserWindow, { log: createFakeLog(), label: 'window' });

  browserWindow.emit('render-process-gone', { reason: 'clean-exit', exitCode: 0 });
  browserWindow.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  browserWindow.destroy();
  await setTimeout(150);

  assert.equal(browserWindow.state.reloads, 0);
});
