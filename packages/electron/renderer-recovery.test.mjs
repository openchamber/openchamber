import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { attachRendererRecovery, createRendererRecoveryPolicy, takeSafeStart } from './renderer-recovery.mjs';

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

test('reloads the first two crashes in a row, safe-starts the third and stops at the fourth', () => {
  let currentTime = 1_000;
  const policy = createRendererRecoveryPolicy(() => currentTime);

  // Issue 4907: one crash about 25 s after every reload.
  const steps = [];
  for (let crash = 0; crash < 5; crash += 1) {
    steps.push(policy.nextStep('crashed'));
    currentTime += 25_000;
  }

  assert.deepEqual(steps, ['reload', 'reload', 'safe-start', 'stop', 'stop']);
});

test('counts every recoverable reason toward the same crashes in a row', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.nextStep('crashed'), 'reload');
  assert.equal(policy.nextStep('oom'), 'reload');
  assert.equal(policy.nextStep('memory-eviction'), 'safe-start');
  assert.equal(policy.nextStep('abnormal-exit'), 'stop');
});

test('ignores clean, killed and unknown renderer exits without counting them', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.nextStep('clean-exit'), 'ignore');
  assert.equal(policy.nextStep('killed'), 'ignore');
  assert.equal(policy.nextStep('launch-failed'), 'ignore');
  assert.equal(policy.nextStep('made-up-reason'), 'ignore');
  assert.equal(policy.nextStep('crashed'), 'reload');
  assert.equal(policy.nextStep('crashed'), 'reload');
});

test('a crash long after the previous one starts a new count', () => {
  let currentTime = 1_000;
  const policy = createRendererRecoveryPolicy(() => currentTime);

  assert.equal(policy.nextStep('crashed'), 'reload');
  assert.equal(policy.nextStep('crashed'), 'reload');
  currentTime += 2 * 60_000;
  assert.equal(policy.nextStep('crashed'), 'reload');
  assert.equal(policy.nextStep('crashed'), 'reload');
  assert.equal(policy.nextStep('crashed'), 'safe-start');
});

test('a window that stopped reloading recovers again after a quiet spell', () => {
  let currentTime = 1_000;
  const policy = createRendererRecoveryPolicy(() => currentTime);

  for (let crash = 0; crash < 4; crash += 1) policy.nextStep('crashed');
  currentTime += 2 * 60_000;

  assert.equal(policy.nextStep('crashed'), 'reload');
});

test('reloads the attached window after a recoverable renderer failure', async () => {
  const browserWindow = createFakeWindow();
  const log = createFakeLog();
  attachRendererRecovery(browserWindow, { log, label: 'mini chat' });

  browserWindow.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  await setTimeout(150);

  assert.equal(browserWindow.state.reloads, 1);
  assert.equal(takeSafeStart(browserWindow.webContents), false);
  assert.equal(log.warnings.length, 1);
  assert.equal(log.warnings[0].payload.surface, 'mini chat');
  assert.equal(log.warnings[0].payload.label, 'main');
});

test('the third crash in a row reloads once without the saved layout, the fourth leaves the window', async () => {
  const browserWindow = createFakeWindow();
  const log = createFakeLog();
  attachRendererRecovery(browserWindow, { log, label: 'window' });

  for (let crash = 0; crash < 3; crash += 1) {
    browserWindow.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  }
  await setTimeout(150);

  assert.equal(browserWindow.state.reloads, 3);
  assert.match(log.warnings[2].message, /without its saved layout/);
  assert.equal(takeSafeStart(browserWindow.webContents), true);
  assert.equal(takeSafeStart(browserWindow.webContents), false);

  browserWindow.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  await setTimeout(150);

  assert.equal(browserWindow.state.reloads, 3);
  assert.match(log.warnings[3].message, /no more reloads/);
  assert.equal(takeSafeStart(browserWindow.webContents), false);
});

test('a safe start belongs to the window that crashed', async () => {
  const crashing = createFakeWindow();
  const other = createFakeWindow();
  attachRendererRecovery(crashing, { log: createFakeLog(), label: 'window' });
  attachRendererRecovery(other, { log: createFakeLog(), label: 'window' });

  for (let crash = 0; crash < 3; crash += 1) {
    crashing.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  }
  other.emit('render-process-gone', { reason: 'crashed', exitCode: 5 });
  await setTimeout(150);

  assert.equal(takeSafeStart(other.webContents), false);
  assert.equal(takeSafeStart(crashing.webContents), true);
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
