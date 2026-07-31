import { describe, expect, it } from 'vitest';

import { resolveGuardianPaths } from './paths.js';

describe('resolveGuardianPaths', () => {
  it('uses the POSIX state root and shared guardian suffix', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      env: { HOME: '/home/alice', XDG_STATE_HOME: '/state' },
    });

    expect(paths.rootDir).toBe('/state/openchamber/managed-opencode-handoff-v2');
    expect(paths.socketPath).toBe(`${paths.rootDir}/guardian.sock`);
    expect(paths.portPath).toBeUndefined();
    expect(paths.authSecretPath).toBe(`${paths.rootDir}/guardian-auth.secret`);
    expect(paths.pidFile).toBe(`${paths.rootDir}/guardian.pid`);
  });

  it('uses the Windows local application root and discovery file', () => {
    const paths = resolveGuardianPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: '/local/appdata' },
    });

    expect(paths.rootDir).toBe('/local/appdata/openchamber/managed-opencode-handoff-v2');
    expect(paths.socketPath).toBeUndefined();
    expect(paths.portPath).toBe(`${paths.rootDir}/port`);
  });

  it('expands an explicit absolute data directory consistently', () => {
    const paths = resolveGuardianPaths({ platform: 'linux', dataDir: '/tmp/openchamber-data' });
    expect(paths.dataDir).toBe('/tmp/openchamber-data');
    expect(paths.rootDir).toBe('/tmp/openchamber-data/managed-opencode-handoff-v2');
  });

  it('derives authentication from a custom POSIX socket root', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      env: { XDG_STATE_HOME: '/default-state' },
      socketPath: '/tmp/custom-guardian/guardian.sock',
    });

    expect(paths.socketPath).toBe('/tmp/custom-guardian/guardian.sock');
    expect(paths.authSecretPath).toBe('/tmp/custom-guardian/guardian-auth.secret');
  });

  it('derives authentication from a custom Windows discovery-file root', () => {
    const paths = resolveGuardianPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: '/default-localappdata' },
      portPath: '/tmp/custom-guardian/port',
    });

    expect(paths.portPath).toBe('/tmp/custom-guardian/port');
    expect(paths.authSecretPath).toBe('/tmp/custom-guardian/guardian-auth.secret');
  });

  it('keeps a custom transport on the explicit data-directory root', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      dataDir: '/tmp/openchamber-data',
      socketPath: '/tmp/custom-guardian/guardian.sock',
    });

    expect(paths.socketPath).toBe('/tmp/custom-guardian/guardian.sock');
    expect(paths.authSecretPath).toBe('/tmp/openchamber-data/managed-opencode-handoff-v2/guardian-auth.secret');
  });

  it('rejects relative data directories', () => {
    expect(() => resolveGuardianPaths({ platform: 'linux', dataDir: 'relative' }))
      .toThrow(/absolute path/);
  });

  it('rejects relative transport overrides', () => {
    expect(() => resolveGuardianPaths({ platform: 'linux', socketPath: 'relative.sock' }))
      .toThrow(/socket path must be an absolute path/);
  });
});
