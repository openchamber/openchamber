import { describe, expect, it } from 'vitest';
import { parseServiceConfig } from './config.js';

const base = {
  version: 1, stateDir: '/var/lib/openchamber-protected-mcp',
  engineSocket: '/run/openchamber-protected-mcp/engine.sock', engineUser: 'dev',
  node: '/usr/bin/node', installDir: '/usr/lib/openchamber-protected-mcp', configDir: '/etc/openchamber/protected-mcp',
};

describe('service configuration', () => {
  it('uses a separate admin socket when configuration omits it', () => {
    // Given / When
    const config = parseServiceConfig(base);
    // Then
    expect(config).toMatchObject({ adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock', subjectsDir: '/run/openchamber-protected-mcp/subjects', adminSocketGroup: null, engineSocketGroup: null, npm: null });
    expect(config).not.toHaveProperty('admin');
  });

  it('ignores the removed listener when old configuration still contains it', () => {
    // Given / When
    const config = parseServiceConfig({ ...base, admin: { host: '0.0.0.0', port: 9000 }, adminSocket: '/run/admin/admin.sock', adminSocketGroup: 123 });
    // Then
    expect(config.adminSocket).toBe('/run/admin/admin.sock');
    expect(config.adminSocketGroup).toBe(123);
    expect(config).not.toHaveProperty('admin');
  });

  it('uses a configured absolute subjects directory', () => {
    // Given an administrator-selected runtime directory.
    const subjectsDir = '/run/custom-mcp/subjects';
    // When configuration is parsed.
    const config = parseServiceConfig({ ...base, subjectsDir });
    // Then the listener owner receives the selected path.
    expect(config.subjectsDir).toBe(subjectsDir);
  });

  it.each([
    { stateDir: 'state' }, { subjectsDir: 'subjects' }, { subjectsDir: '/run/../subjects' }, { node: '/usr/bin/../bin/node' }, { engineUser: 'Dev Account' },
    { adminSocket: 'admin.sock' }, { adminSocket: '/run/../admin.sock' }, { adminSocketGroup: '123' },
    { adminSocketGroup: 1.5 }, { adminSocketGroup: Number.MAX_SAFE_INTEGER + 1 },
    { workerPath: 'bin:/usr/bin' }, { npm: [] }, { version: 2 },
  ])('refuses invalid configuration %j', (change) => {
    // Given / When / Then
    expect(() => parseServiceConfig({ ...base, ...change })).toThrow(expect.objectContaining({ code: 'invalid_config' }));
  });
});
