import assert from 'node:assert/strict';
import test from 'node:test';

import { startDeepLinkHostActivation } from './deep-link-host-activation.mjs';

const flushMicrotasks = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const trackUnhandledRejections = () => {
  const unhandled = [];
  const listener = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', listener);
  return {
    unhandled,
    stop: () => {
      process.removeListener('unhandledRejection', listener);
    },
  };
};

test('reports a rejected host activation and leaves no unhandled rejection', async () => {
  const tracker = trackUnhandledRejections();
  try {
    const failure = new Error('Failed to load URL with error: ERR_CONNECTION_REFUSED');
    const reported = [];
    let activations = 0;
    startDeepLinkHostActivation(
      async () => {
        activations += 1;
        throw failure;
      },
      (error) => {
        reported.push(error);
      },
    );
    await flushMicrotasks();
    assert.equal(activations, 1);
    assert.deepEqual(reported, [failure]);
    assert.deepEqual(tracker.unhandled, []);
  } finally {
    tracker.stop();
  }
});

test('reports nothing when the host activation succeeds', async () => {
  const tracker = trackUnhandledRejections();
  try {
    const reported = [];
    let activations = 0;
    startDeepLinkHostActivation(
      async () => {
        activations += 1;
      },
      (error) => {
        reported.push(error);
      },
    );
    await flushMicrotasks();
    assert.equal(activations, 1);
    assert.deepEqual(reported, []);
    assert.deepEqual(tracker.unhandled, []);
  } finally {
    tracker.stop();
  }
});

test('a throwing reporter cannot re-arm the rejection', async () => {
  const tracker = trackUnhandledRejections();
  try {
    startDeepLinkHostActivation(
      async () => {
        throw new Error('navigation failed');
      },
      () => {
        throw new Error('log write failed');
      },
    );
    await flushMicrotasks();
    assert.deepEqual(tracker.unhandled, []);
  } finally {
    tracker.stop();
  }
});
