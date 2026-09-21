import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAST_HOST_PROBE_TIMEOUT_MS,
  RETRY_HOST_PROBE_TIMEOUT_MS,
  probeDirectHostWithRetry,
} from './host-probe-policy.mjs';

test('retries a fast unreachable direct-host probe with the slow timeout', async () => {
  const timeouts = [];
  const result = await probeDirectHostWithRetry(async (timeoutMs) => {
    timeouts.push(timeoutMs);
    return timeoutMs === FAST_HOST_PROBE_TIMEOUT_MS
      ? { status: 'unreachable', latencyMs: timeoutMs }
      : { status: 'ok', latencyMs: 2_500 };
  });

  assert.deepEqual(timeouts, [FAST_HOST_PROBE_TIMEOUT_MS, RETRY_HOST_PROBE_TIMEOUT_MS]);
  assert.deepEqual(result, { status: 'ok', latencyMs: 2_500 });
});

for (const status of ['ok', 'auth', 'wrong-service', 'incompatible', 'update-recommended']) {
  test(`does not retry an authoritative ${status} result`, async () => {
    const timeouts = [];
    const result = await probeDirectHostWithRetry(async (timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status, latencyMs: 12 };
    });

    assert.deepEqual(timeouts, [FAST_HOST_PROBE_TIMEOUT_MS]);
    assert.equal(result.status, status);
  });
}

test('stops after one unreachable retry', async () => {
  const timeouts = [];
  const result = await probeDirectHostWithRetry(async (timeoutMs) => {
    timeouts.push(timeoutMs);
    return { status: 'unreachable', latencyMs: timeoutMs };
  });
  assert.deepEqual(timeouts, [2_000, 10_000]);
  assert.equal(result.status, 'unreachable');
});
