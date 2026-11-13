import { describe, expect, it } from 'vitest';
import { createWebSourceControlAPI } from './source-control';

const readContext = {
  directory: '/repo', repositoryId: 'repository', accountId: 'account', bindingRevision: 1, primaryRemote: 'origin',
};
const githubIdentities = [
  { provider: 'github', instance: 'github.com' },
  { provider: 'github', instance: 'github.enterprise.example' },
] as const;
const legacyIdentities = [
  { provider: 'gitea', instance: 'https://gitea.example' },
  { provider: 'forgejo', instance: 'https://forgejo.example' },
  { provider: 'gerrit', instance: 'https://gerrit.example' },
  { provider: 'ext-review', instance: 'https://extension.example' },
  { provider: 'gitlab', instance: 'https://gitlab.example' },
] as const;

for (const identity of legacyIdentities) {
  describe(`upstream compatibility for ${identity.provider}`, () => {
    it.each([true, false])('preserves omitted push evidence when isFork=%s', async (isFork) => {
      // Given
      const upstream = isFork ? { ...identity, id: 'parent/repo', owner: 'parent', name: 'repo',
        url: `${identity.instance}/parent/repo` } : null;
      const api = createWebSourceControlAPI({ fetch: async () => Response.json({ identity, isFork, upstream }) });

      // When
      const result = await api.projectUpstream({ ...readContext, ...identity });

      // Then
      expect(result).toEqual({ identity, isFork, upstream });
      expect(result).not.toHaveProperty('viewerCanPush');
    });
  });
}

for (const identity of githubIdentities) {
  it(`rejects omitted GitHub push evidence on ${identity.instance}`, async () => {
    // Given
    const api = createWebSourceControlAPI({ fetch: async () => Response.json({ identity, isFork: false, upstream: null }) });

    // When / Then
    await expect(api.projectUpstream({ ...readContext, ...identity, instance: `https://${identity.instance}/` }))
      .rejects.toThrow('invalid upstream');
  });
}

for (const identity of [...githubIdentities, ...legacyIdentities]) {
  describe(`upstream push evidence for ${identity.provider} on ${identity.instance}`, () => {
    it.each([true, false])('retains explicit %s without coercion', async (viewerCanPush) => {
      // Given
      const api = createWebSourceControlAPI({ fetch: async () => Response.json({ identity, isFork: false, upstream: null, viewerCanPush }) });

      // When
      const result = await api.projectUpstream({ ...readContext, ...identity });

      // Then
      expect(result).toEqual({ identity, isFork: false, upstream: null, viewerCanPush });
    });

    it.each([
      { viewerCanPush: null }, { viewerCanPush: 'true' }, { viewerCanPush: 1 }, { viewerCanPush: {} }, { viewerCanPush: [] },
    ])('rejects provided nonboolean evidence %j', async ({ viewerCanPush }) => {
      // Given
      const api = createWebSourceControlAPI({ fetch: async () => Response.json({ identity, isFork: false, upstream: null, viewerCanPush }) });

      // When / Then
      await expect(api.projectUpstream({ ...readContext, ...identity })).rejects.toThrow('invalid upstream');
    });
  });
}
