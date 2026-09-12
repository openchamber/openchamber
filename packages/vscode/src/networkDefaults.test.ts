import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { applyConnectAttemptTimeout } from './networkDefaults';

test('allows slow connections without changing address-family selection', () => {
  const previousTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
  const previousFamily = net.getDefaultAutoSelectFamily();
  try {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    assert.equal(applyConnectAttemptTimeout(), true);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5_000);
    assert.equal(net.getDefaultAutoSelectFamily(), previousFamily);
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(previousTimeout);
  }
});

test('unsupported runtimes retain their existing behavior', () => {
  assert.equal(applyConnectAttemptTimeout({}), false);
  assert.equal(applyConnectAttemptTimeout({
    setDefaultAutoSelectFamilyAttemptTimeout() { throw new Error('unsupported'); },
  }), false);
});
