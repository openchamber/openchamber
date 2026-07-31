import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { resolveGuardianPaths } from './paths.js';

describe('resolveGuardianPaths', () => {
  it('uses the POSIX state root and shared guardian suffix', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      env: { HOME: '/home/alice', XDG_STATE_HOME: '/state' },
    });
    const expectedRoot = path.resolve('/state/openchamber/managed-opencode-handoff-v2');

    expect(paths.rootDir).toBe(expectedRoot);
    expect(paths.socketPath).toBe(path.join(expectedRoot, 'guardian.sock'));
    expect(paths.portPath).toBeUndefined();
    expect(paths.authSecretPath).toBe(path.join(expectedRoot, 'guardian-auth.secret'));
    expect(paths.pidFile).toBe(path.join(expectedRoot, 'guardian.pid'));
  });

  it('uses the Windows local application root and discovery file', () => {
    const paths = resolveGuardianPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: '/local/appdata' },
    });
    const expectedRoot = path.resolve('/local/appdata/openchamber/managed-opencode-handoff-v2');

    expect(paths.rootDir).toBe(expectedRoot);
    expect(paths.socketPath).toBeUndefined();
    expect(paths.portPath).toBe(path.join(expectedRoot, 'port'));
  });

  it('expands an explicit absolute data directory consistently', () => {
    const paths = resolveGuardianPaths({ platform: 'linux', dataDir: '/tmp/openchamber-data' });
    const expectedDataDir = path.resolve('/tmp/openchamber-data');
    expect(paths.dataDir).toBe(expectedDataDir);
    expect(paths.rootDir).toBe(path.join(expectedDataDir, 'managed-opencode-handoff-v2'));
  });

  it('derives authentication from a custom POSIX socket root', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      env: { XDG_STATE_HOME: '/default-state' },
      socketPath: '/tmp/custom-guardian/guardian.sock',
    });
    const customSocketPath = path.resolve('/tmp/custom-guardian/guardian.sock');

    expect(paths.socketPath).toBe(customSocketPath);
    expect(paths.authSecretPath).toBe(path.join(path.dirname(customSocketPath), 'guardian-auth.secret'));
  });

  it('derives authentication from a custom Windows discovery-file root', () => {
    const paths = resolveGuardianPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: '/default-localappdata' },
      portPath: '/tmp/custom-guardian/port',
    });
    const customPortPath = path.resolve('/tmp/custom-guardian/port');

    expect(paths.portPath).toBe(customPortPath);
    expect(paths.authSecretPath).toBe(path.join(path.dirname(customPortPath), 'guardian-auth.secret'));
  });

  it('keeps a custom transport on the explicit data-directory root', () => {
    const paths = resolveGuardianPaths({
      platform: 'linux',
      dataDir: '/tmp/openchamber-data',
      socketPath: '/tmp/custom-guardian/guardian.sock',
    });
    const expectedDataRoot = path.join(path.resolve('/tmp/openchamber-data'), 'managed-opencode-handoff-v2');
    const customSocketPath = path.resolve('/tmp/custom-guardian/guardian.sock');

    expect(paths.socketPath).toBe(customSocketPath);
    expect(paths.authSecretPath).toBe(path.join(expectedDataRoot, 'guardian-auth.secret'));
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
