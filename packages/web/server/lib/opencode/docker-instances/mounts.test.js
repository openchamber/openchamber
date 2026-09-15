import { describe, expect, it } from 'vitest';

import { buildInstanceMounts, CONTAINER_OPENCODE_PORT } from './mounts.js';

const PATHS = {
  openCodeConfigDir: 'C:\\Users\\me\\.config\\opencode',
  skillDir: 'C:\\Users\\me\\.config\\opencode\\skills',
  authFile: 'C:\\Users\\me\\.local\\share\\opencode\\auth.json',
};

const instance = (overrides = {}) => ({
  workspaceHostPath: 'C:\\proj\\foo',
  workspaceContainerPath: '/workspace',
  sharing: { config: false, skills: false, credentials: false, skillsHostDir: null },
  ...overrides,
});

describe('buildInstanceMounts', () => {
  it('mounts exactly the workspace read-write when every sharing toggle is off', () => {
    const mounts = buildInstanceMounts({ instance: instance(), paths: PATHS });
    expect(mounts).toEqual([{ host: 'C:\\proj\\foo', container: '/workspace', mode: 'rw' }]);
    expect(CONTAINER_OPENCODE_PORT).toBe(4096);
  });

  it('adds the shared skills mount read-write and the config mount two-way when opted in', () => {
    const mounts = buildInstanceMounts({
      instance: instance({ sharing: { config: true, skills: true, credentials: false, skillsHostDir: null } }),
      paths: PATHS,
    });
    expect(mounts).toEqual([
      { host: 'C:\\proj\\foo', container: '/workspace', mode: 'rw' },
      { host: PATHS.skillDir, container: '/home/opencode/.config/opencode/skills', mode: 'rw' },
      { host: PATHS.openCodeConfigDir, container: '/home/opencode/.config/opencode', mode: 'rw' },
    ]);
  });

  it('mounts credentials only when explicitly enabled and always read-only', () => {
    const off = buildInstanceMounts({ instance: instance(), paths: PATHS });
    expect(off.some((mount) => mount.host === PATHS.authFile)).toBe(false);

    const on = buildInstanceMounts({
      instance: instance({ sharing: { config: false, skills: false, credentials: true, skillsHostDir: null } }),
      paths: PATHS,
    });
    expect(on).toEqual([
      { host: 'C:\\proj\\foo', container: '/workspace', mode: 'rw' },
      { host: PATHS.authFile, container: '/home/opencode/.local/share/opencode/auth.json', mode: 'ro' },
    ]);
  });

  it('honors a custom shared skills directory over the default skill dir', () => {
    const mounts = buildInstanceMounts({
      instance: instance({ sharing: { config: false, skills: true, credentials: false, skillsHostDir: 'D:\\shared-skills' } }),
      paths: PATHS,
    });
    expect(mounts[1]).toEqual({ host: 'D:\\shared-skills', container: '/home/opencode/.config/opencode/skills', mode: 'rw' });
  });

  it('refuses to mount the docker socket, ssh material, or git credential paths', () => {
    const forbidden = [
      { workspaceHostPath: '/var/run/docker.sock' },
      { workspaceHostPath: 'C:\\Users\\me\\.ssh' },
      { workspaceHostPath: 'C:\\Users\\me\\.git-credentials' },
      { workspaceHostPath: 'C:\\proj\\id_rsa' },
      // The user-suppliable skills override must pass the same guard — a
      // request mounting the docker socket (or SSH material) through it would
      // defeat the isolation model.
      { sharing: { config: false, skills: true, credentials: false, skillsHostDir: '/var/run/docker.sock' } },
      { sharing: { config: false, skills: true, credentials: false, skillsHostDir: 'C:\\Users\\me\\.ssh' } },
      { sharing: { config: false, skills: true, credentials: false, skillsHostDir: 'C:\\Users\\me\\.git-credentials' } },
    ];
    for (const candidate of forbidden) {
      expect(() => buildInstanceMounts({ instance: instance(candidate), paths: PATHS }))
        .toThrow(/forbidden host path/);
    }
  });

  it('requires a workspace host path', () => {
    expect(() => buildInstanceMounts({ instance: instance({ workspaceHostPath: '  ' }), paths: PATHS }))
      .toThrow(/workspace host path/);
  });
});
