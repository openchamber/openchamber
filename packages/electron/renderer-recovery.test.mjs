import assert from 'node:assert/strict';
import test from 'node:test';

import { createRendererRecoveryPolicy } from './renderer-recovery.mjs';

test('allows a bounded number of reloads for recoverable renderer failures', () => {
  const policy = createRendererRecoveryPolicy(() => 1_000);

  assert.equal(policy.shouldReload('crashed'), true);
  assert.equal(policy.shouldReload('oom'), true);
  assert.equal(policy.shouldReload('abnormal-exit'), true);
  assert.equal(policy.shouldReload('memory-eviction'), false);
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
