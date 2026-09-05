import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  buildPublicSocketBindings,
  expandHomePath,
  resolveAgentSocketEnv,
  resolveSocketBinding,
} from './sockets.js';

const dockerBinding = {
  id: 'docker',
  candidatesByPlatform: {
    linux: ['/var/run/docker.sock', '/run/user/1000/docker.sock'],
    darwin: ['~/.docker/run/docker.sock', '~/.colima/default/docker.sock'],
    win32: ['//./pipe/docker_engine'],
  },
};

describe('expandHomePath', () => {
  test('expands ~ and leaves absolute paths alone', () => {
    expect(expandHomePath('~/run/docker.sock', '/Users/user')).toBe(
      path.join('/Users/user', 'run/docker.sock'),
    );
    expect(expandHomePath('/var/run/docker.sock', '/Users/user')).toBe('/var/run/docker.sock');
  });
});

describe('resolveSocketBinding', () => {
  test('override wins before candidates', async () => {
    const resolved = await resolveSocketBinding(dockerBinding, {
      override: '~/custom.sock',
      platform: 'darwin',
      home: '/Users/user',
      access: async () => {
        throw new Error('should not access');
      },
    });
    expect(resolved).toBe(path.join('/Users/user', 'custom.sock'));
  });

  test('picks the first existing candidate for the platform', async () => {
    const seen = [];
    const resolved = await resolveSocketBinding(dockerBinding, {
      platform: 'linux',
      access: async (candidate) => {
        seen.push(candidate);
        if (candidate !== '/run/user/1000/docker.sock') {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
      },
    });
    expect(resolved).toBe('/run/user/1000/docker.sock');
    expect(seen).toEqual(['/var/run/docker.sock', '/run/user/1000/docker.sock']);
  });

  test('returns null when nothing exists', async () => {
    const resolved = await resolveSocketBinding(dockerBinding, {
      platform: 'darwin',
      home: '/Users/user',
      access: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    });
    expect(resolved).toBeNull();
  });
});

describe('buildPublicSocketBindings', () => {
  test('exposes candidates, override, and resolved for the catalog', async () => {
    const [binding] = await buildPublicSocketBindings(
      [dockerBinding],
      { docker: '/tmp/docker.sock' },
      {
        platform: 'darwin',
        home: '/Users/user',
        access: async () => undefined,
      },
    );
    expect(binding).toEqual({
      id: 'docker',
      candidates: [
        path.join('/Users/user', '.docker/run/docker.sock'),
        path.join('/Users/user', '.colima/default/docker.sock'),
      ],
      resolved: '/tmp/docker.sock',
      override: '/tmp/docker.sock',
    });
  });
});

describe('resolveAgentSocketEnv', () => {
  test('builds OPENCHAMBER_AGENT_SOCKETS map from resolved bindings', async () => {
    const env = await resolveAgentSocketEnv(
      [dockerBinding],
      {},
      {
        platform: 'linux',
        access: async (candidate) => {
          if (candidate !== '/var/run/docker.sock') {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
      },
    );
    expect(env).toEqual({
      docker: '/var/run/docker.sock',
    });
  });
});
