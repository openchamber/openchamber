import { describe, expect, it } from 'vitest';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';

const flow = {
  provider: 'gitlab',
  instance: 'https://gitlab.example.com',
  deviceCode: 'raw-device-code',
  clientId: 'oauth-client',
  expiresIn: 600,
};
const identityFor = (flowId, overrides = {}) => ({
  flowId,
  provider: flow.provider,
  instance: flow.instance,
  ...overrides,
});

describe('source-control OAuth flow registry', () => {
  it('registers opaque random IDs without returning the raw device code', () => {
    const registry = createOAuthFlowRegistry();
    const first = registry.register(flow);
    const second = registry.register(flow);

    expect(first.flowId).toMatch(/^oauth_[A-Za-z0-9_-]{43}$/);
    expect(second.flowId).not.toBe(first.flowId);
    expect(JSON.stringify(first)).not.toContain(flow.deviceCode);
    expect(registry.acquire(identityFor(first.flowId))).toEqual({
      deviceCode: flow.deviceCode,
      clientId: flow.clientId,
      expiresAt: first.expiresAt,
    });
  });

  it('requires the exact provider and caller-normalized instance', () => {
    const registry = createOAuthFlowRegistry();
    const { flowId } = registry.register(flow);

    expect(() => registry.acquire(identityFor(flowId, { provider: 'github' })))
      .toThrow(expect.objectContaining({ code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE' }));
    expect(() => registry.acquire(identityFor(flowId, { instance: 'https://GITLAB.example.com' })))
      .toThrow(expect.objectContaining({ code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE' }));
    expect(registry.acquire(identityFor(flowId))).toMatchObject({ deviceCode: flow.deviceCode });
  });

  it('rejects unknown, expired, consumed, and overlapping acquisitions without leaking the code', () => {
    let timestamp = 1_000;
    const registry = createOAuthFlowRegistry({ now: () => timestamp });
    const active = registry.register(flow);
    registry.acquire(identityFor(active.flowId));

    const errors = [];
    for (const attempt of [
      () => registry.acquire(identityFor('oauth_unknown')),
      () => registry.acquire(identityFor(active.flowId)),
    ]) {
      try {
        attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    registry.consume(active.flowId);
    try {
      registry.acquire(identityFor(active.flowId));
    } catch (error) {
      errors.push(error);
    }

    const expiring = registry.register({ ...flow, expiresIn: 1 });
    timestamp = expiring.expiresAt;
    try {
      registry.acquire(identityFor(expiring.flowId));
    } catch (error) {
      errors.push(error);
    }

    expect(errors).toHaveLength(4);
    expect(errors[1]).toMatchObject({ code: 'SOURCE_CONTROL_OAUTH_FLOW_BUSY', message: 'OAuth flow is busy' });
    for (const [index, error] of errors.entries()) {
      if (index !== 1) {
        expect(error).toMatchObject({
          code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE',
          message: 'OAuth flow is unavailable',
        });
      }
      expect(JSON.stringify(error)).not.toContain(flow.deviceCode);
      expect(error.message).not.toContain(flow.deviceCode);
    }
  });

  it('releases retryable attempts and consumes terminal attempts', () => {
    const registry = createOAuthFlowRegistry();
    const retryable = registry.register(flow);
    registry.acquire(identityFor(retryable.flowId));

    expect(registry.release(retryable.flowId)).toBe(true);
    expect(registry.acquire(identityFor(retryable.flowId))).toMatchObject({ deviceCode: flow.deviceCode });
    expect(registry.consume(retryable.flowId)).toBe(true);
    expect(() => registry.acquire(identityFor(retryable.flowId)))
      .toThrow(expect.objectContaining({ code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE' }));
  });

  it('caps provider TTLs and falls back defensively for invalid TTLs', () => {
    const timestamp = 5_000;
    const registry = createOAuthFlowRegistry({
      now: () => timestamp,
      maxTtlMs: 30_000,
      defaultTtlMs: 10_000,
    });

    expect(registry.register({ ...flow, expiresIn: 120 }).expiresAt).toBe(timestamp + 30_000);
    expect(registry.register({ ...flow, expiresIn: Number.NaN }).expiresAt).toBe(timestamp + 10_000);
    expect(registry.register({ ...flow, expiresIn: -1 }).expiresAt).toBe(timestamp + 10_000);
  });

  it('prunes expired entries before enforcing the entry bound', () => {
    let timestamp = 0;
    const registry = createOAuthFlowRegistry({ now: () => timestamp, maxEntries: 2 });
    registry.register({ ...flow, expiresIn: 1 });
    registry.register({ ...flow, expiresIn: 60 });

    expect(() => registry.register(flow)).toThrow(expect.objectContaining({
      code: 'SOURCE_CONTROL_OAUTH_FLOW_CAPACITY',
    }));
    timestamp = 1_000;
    expect(() => registry.register(flow)).not.toThrow();
  });

  it('keeps flows local to each registry instance', () => {
    const beforeRestart = createOAuthFlowRegistry();
    const { flowId } = beforeRestart.register(flow);
    const afterRestart = createOAuthFlowRegistry();

    expect(() => afterRestart.acquire(identityFor(flowId)))
      .toThrow(expect.objectContaining({ code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE' }));
  });
});
