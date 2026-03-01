import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuthenticatedInstanceIdsByRecency,
  isLikelyLocalHostname,
  isLocalOpenChamberHealthPayload,
  shouldBypassDeviceLoginForVerification,
  shouldForceDeviceLogin,
  shouldForceMobileDeviceLogin,
} from '../src/lib/auth/deviceLoginGate';

describe('device login gate helpers', () => {
  it('detects local hostnames and private network addresses', () => {
    assert.equal(isLikelyLocalHostname('localhost'), true);
    assert.equal(isLikelyLocalHostname('::1'), true);
    assert.equal(isLikelyLocalHostname('192.168.1.42'), true);
    assert.equal(isLikelyLocalHostname('10.0.0.5'), true);
    assert.equal(isLikelyLocalHostname('172.16.8.2'), true);
    assert.equal(isLikelyLocalHostname('172.31.255.255'), true);
    assert.equal(isLikelyLocalHostname('devbox.local'), true);
  });

  it('does not mark public hosts as local', () => {
    assert.equal(isLikelyLocalHostname('8.8.8.8'), false);
    assert.equal(isLikelyLocalHostname('example.com'), false);
    assert.equal(isLikelyLocalHostname('172.32.0.1'), false);
    assert.equal(isLikelyLocalHostname('256.0.0.1'), false);
  });

  it('treats healthy local health payloads as available', () => {
    assert.equal(isLocalOpenChamberHealthPayload({ status: 'ok' }), true);
    assert.equal(isLocalOpenChamberHealthPayload({ openCodeRunning: true }), true);
    assert.equal(isLocalOpenChamberHealthPayload({ openCodePort: 4096 }), true);
  });

  it('treats unhealthy payloads as unavailable', () => {
    assert.equal(isLocalOpenChamberHealthPayload(null), false);
    assert.equal(isLocalOpenChamberHealthPayload({ status: 'down' }), false);
    assert.equal(isLocalOpenChamberHealthPayload({ openCodeRunning: false }), false);
    assert.equal(isLocalOpenChamberHealthPayload({ openCodePort: '4096' }), false);
  });

  it('forces device login only when no instance and no local runtime', () => {
    assert.equal(shouldForceDeviceLogin({
      hydrated: true,
      instancesCount: 0,
      hasDesktopSidecar: false,
      localSidecarStatus: 'not-running',
    }), true);

    assert.equal(shouldForceDeviceLogin({
      hydrated: true,
      instancesCount: 0,
      hasDesktopSidecar: true,
      localSidecarStatus: 'not-running',
    }), false);

    assert.equal(shouldForceDeviceLogin({
      hydrated: true,
      instancesCount: 0,
      hasDesktopSidecar: false,
      localSidecarStatus: 'running',
    }), false);

    assert.equal(shouldForceDeviceLogin({
      hydrated: true,
      instancesCount: 2,
      hasDesktopSidecar: false,
      localSidecarStatus: 'not-running',
    }), false);
  });

  it('bypasses gate when verification query params are present', () => {
    assert.equal(shouldBypassDeviceLoginForVerification('?devices=1'), true);
    assert.equal(shouldBypassDeviceLoginForVerification('?settings=settings&section=openchamber&devices=1&user_code=ABCD-EFGH'), true);
    assert.equal(shouldBypassDeviceLoginForVerification('?user_code=ABCD-EFGH'), true);
    assert.equal(shouldBypassDeviceLoginForVerification('?section=openchamber'), false);
  });

  it('selects authenticated instances by recency', () => {
    const ids = getAuthenticatedInstanceIdsByRecency(
      [
        { id: 'inst-a', lastUsedAt: 20 },
        { id: 'inst-b', lastUsedAt: 30 },
        { id: 'inst-c', lastUsedAt: null },
        { id: 'inst-d', lastUsedAt: 10 },
      ],
      (instanceId) => instanceId === 'inst-a' || instanceId === 'inst-b' || instanceId === 'inst-c',
    );

    assert.deepEqual(ids, ['inst-b', 'inst-a', 'inst-c']);
  });

  it('forces mobile device login only when no authenticated remote instances exist', () => {
    assert.equal(shouldForceMobileDeviceLogin({
      isMobileRuntime: true,
      hydrated: true,
      hasDesktopSidecar: false,
      authenticatedInstancesCount: 0,
    }), true);

    assert.equal(shouldForceMobileDeviceLogin({
      isMobileRuntime: true,
      hydrated: true,
      hasDesktopSidecar: false,
      authenticatedInstancesCount: 1,
    }), false);

    assert.equal(shouldForceMobileDeviceLogin({
      isMobileRuntime: true,
      hydrated: true,
      hasDesktopSidecar: true,
      authenticatedInstancesCount: 0,
    }), false);

    assert.equal(shouldForceMobileDeviceLogin({
      isMobileRuntime: false,
      hydrated: true,
      hasDesktopSidecar: false,
      authenticatedInstancesCount: 0,
    }), false);
  });
});
