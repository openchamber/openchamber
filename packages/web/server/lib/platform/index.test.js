import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_VAR = 'OPENCHAMBER_PLATFORM_DATABASE_URL';

describe('platform module entry', () => {
  const originalValue = process.env[ENV_VAR];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalValue;
    }
  });

  it('is disabled when OPENCHAMBER_PLATFORM_DATABASE_URL is unset', async () => {
    delete process.env[ENV_VAR];
    vi.resetModules();
    const platform = await import('./index.js');
    expect(platform.platformState.disabled).toBe(true);
    expect(platform.isPlatformEnabled()).toBe(false);
    await expect(platform.createMigratedPlatformDb()).rejects.toThrow(/disabled/);
  });

  it('is enabled when OPENCHAMBER_PLATFORM_DATABASE_URL is set', async () => {
    process.env[ENV_VAR] = 'postgres://platform:secret@127.0.0.1:5432/platform';
    vi.resetModules();
    const platform = await import('./index.js');
    expect(platform.platformState.disabled).toBe(false);
    expect(platform.isPlatformEnabled()).toBe(true);
    expect(platform.platformState.connectionString).toBe(process.env[ENV_VAR]);
  });

  it('exposes the data-layer entry points either way', async () => {
    delete process.env[ENV_VAR];
    vi.resetModules();
    const platform = await import('./index.js');
    for (const exportName of [
      'createPlatformDb', 'migrate', 'importUser', 'changeUserHome', 'normalizeHomePath', 'writeAuditEvent',
    ]) {
      expect(typeof platform[exportName]).toBe('function');
    }
  });
});
