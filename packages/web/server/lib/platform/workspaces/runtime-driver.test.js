import { describe, expect, it } from 'vitest';

import {
  createFakeRuntimeDriver,
  resolveRuntimeDriver,
} from './runtime-driver.js';

describe('runtime driver resolution', () => {
  it('resolves the fake driver by default and via env', () => {
    expect(resolveRuntimeDriver({ env: {} }).name).toBe('fake');
    expect(resolveRuntimeDriver({ env: { OPENCHAMBER_RUNTIME_DRIVER: 'fake' } }).name).toBe('fake');
  });

  it('honors OPENCHAMBER_RUNTIME_MAX_CONCURRENT for the fake driver capacity', () => {
    const driver = resolveRuntimeDriver({
      env: { OPENCHAMBER_RUNTIME_DRIVER: 'fake', OPENCHAMBER_RUNTIME_MAX_CONCURRENT: '1' },
    });
    expect(driver.name).toBe('fake');
  });

  it('docker driver throws honestly instead of pretending (no Docker here)', () => {
    expect(() => resolveRuntimeDriver({ env: { OPENCHAMBER_RUNTIME_DRIVER: 'docker' } }))
      .toThrow(/docker runtime driver is not implemented in this environment - pending Linux host/);
  });

  it('rejects an unknown driver name', () => {
    expect(() => resolveRuntimeDriver({ env: { OPENCHAMBER_RUNTIME_DRIVER: 'kubernetes' } }))
      .toThrow(/unknown OPENCHAMBER_RUNTIME_DRIVER/);
  });

  it('validates fake driver capacity config', () => {
    expect(() => createFakeRuntimeDriver({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});
