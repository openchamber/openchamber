import { describe, expect, it, vi } from 'vitest';
import { lockCapability, readInstanceVersion } from './capabilities.js';
import { createGiteaClient } from './client.js';
import { fakeGitea } from './fixtures/fake-fetch.js';
import { createGiteaResourceService } from './resources.js';

const clientOn = (origin, version) => {
  const gitea = fakeGitea(version === undefined ? {} : { 'GET /version': { version } });
  return { client: createGiteaClient({ origin, token: 'pat-1', fetch: gitea.fetch, delay: async () => {} }), gitea };
};

describe('Gitea lock capability', () => {
  it.each([
    ['1.24.3', 'gitea', true],
    ['1.23.11', 'gitea', false],
    ['1.21.11', 'gitea', false],
    ['2.0.0', 'gitea', true],
    ['9.0.3+gitea-1.22.0', 'forgejo', false],
    ['9.0.3+gitea-1.24.0', 'forgejo', true],
    ['16.0.6', 'forgejo', false],
    [null, 'gitea', null],
    ['development', 'gitea', null],
  ])('answers %s on %s as %s', (version, provider, expected) => {
    expect(lockCapability(version, provider)).toBe(expected);
  });

  it('reads the host version once per instance and keeps it', async () => {
    const { client, gitea } = clientOn('https://version-cache.example.com', '1.24.3');

    await expect(readInstanceVersion(client, 'https://version-cache.example.com')).resolves.toBe('1.24.3');
    await expect(readInstanceVersion(client, 'https://version-cache.example.com')).resolves.toBe('1.24.3');
    expect(gitea.calls.filter((call) => call.url.pathname.endsWith('/version'))).toHaveLength(1);
  });

  it('answers unknown when the version cannot be read', async () => {
    const { client } = clientOn('https://version-unreadable.example.com', undefined);

    await expect(readInstanceVersion(client, 'https://version-unreadable.example.com')).resolves.toBeNull();
  });

  it('answers the service capability from the version this instance names', async () => {
    const origin = 'https://gitea-124.example.com';
    const { client } = clientOn(origin, '1.24.3');
    const service = createGiteaResourceService({ origin, client, resolveRepos: vi.fn() });

    await expect(service.repoCapabilities()).resolves.toEqual({ lock: true });
  });

  it('answers a Forgejo instance by the Gitea base its version carries', async () => {
    const origin = 'https://forgejo-9.example.com';
    const { client } = clientOn(origin, '9.0.3+gitea-1.22.0');
    const service = createGiteaResourceService({ origin, client, resolveRepos: vi.fn(), provider: 'forgejo', providerLabel: 'Forgejo' });

    await expect(service.repoCapabilities()).resolves.toEqual({ lock: false });
  });
});
