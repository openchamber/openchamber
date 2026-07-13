import { describe, expect, test, beforeEach } from 'bun:test';
import { createReconnectPolicy } from '../reconnect-policy';

describe('createReconnectPolicy', () => {
  let policy: ReturnType<typeof createReconnectPolicy>;

  beforeEach(() => {
    policy = createReconnectPolicy();
  });

  test('returns a delay on first attempt', () => {
    const { delayMs, reason } = policy.nextDelay(1, false);
    expect(delayMs).toBeGreaterThanOrEqual(250);
    expect(reason).toBe('attempt_1');
  });

  test('increases delay with more attempts (exponential backoff)', () => {
    const delays: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const { delayMs } = policy.nextDelay(i, false);
      delays.push(delayMs);
    }
    expect(delays[4]).toBeGreaterThanOrEqual(delays[0]);
  });

  test('caps delay at reasonable bound', () => {
    for (let i = 1; i <= 10; i++) {
      const { delayMs } = policy.nextDelay(i, false);
      expect(delayMs).toBeLessThan(65000);
    }
  });

  test('returns long cap for permanent errors', () => {
    const { delayMs, reason } = policy.nextDelay(1, true);
    expect(delayMs).toBeGreaterThanOrEqual(60000);
    expect(reason).toBe('permanent_error');
  });

  test('reset() resets backoff', () => {
    policy.nextDelay(5, false);
    policy.reset();
    const { delayMs } = policy.nextDelay(1, false);
    expect(delayMs).toBeLessThan(6000);
  });

  test('host A backoff does not affect host B', () => {
    const policyA = createReconnectPolicy();
    const policyB = createReconnectPolicy();

    for (let i = 1; i <= 5; i++) policyA.nextDelay(i, false);

    const { delayMs } = policyB.nextDelay(1, false);
    expect(delayMs).toBeLessThan(6000);
  });
});
