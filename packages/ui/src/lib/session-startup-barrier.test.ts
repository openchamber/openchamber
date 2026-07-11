import { afterEach, describe, expect, test } from 'bun:test';

import {
  beginSessionStartupBarrier,
  isSessionStartupBarrierActive,
  releaseSessionStartupBarrier,
  waitForSessionStartupBarrier,
} from './session-startup-barrier';

describe('session startup barrier', () => {
  afterEach(() => releaseSessionStartupBarrier());

  test('holds work until the root session pass releases it', async () => {
    beginSessionStartupBarrier();
    let released = false;
    const waiting = waitForSessionStartupBarrier().then(() => { released = true; });

    await Promise.resolve();
    expect(isSessionStartupBarrierActive()).toBe(true);
    expect(released).toBe(false);

    releaseSessionStartupBarrier();
    await waiting;
    expect(released).toBe(true);
  });
});
