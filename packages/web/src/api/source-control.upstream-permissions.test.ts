import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import { createWebSourceControlAPI } from './source-control';

const runtimeFetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
const otherProviders = [
  { provider: 'gitea', instance: 'https://gitea.example' },
  { provider: 'forgejo', instance: 'https://forgejo.example' },
  { provider: 'gerrit', instance: 'https://gerrit.example' },
  { provider: 'ext-review', instance: 'https://review.example' },
] as const;
const githubInstances = [
  { provider: 'github', instance: 'github.com' },
  { provider: 'github', instance: 'github.enterprise.example' },
] as const;
const malformedEvidence = [null, 'true', 'false', 0, 1, {}, []] as const;

afterEach(() => {
  runtimeFetchMock.mockReset();
});

describe.each([...otherProviders, ...githubInstances])('upstream push evidence for $provider on $instance', (identity) => {
  const context: SourceControlReadContext = {
    ...identity,
    directory: '/workspace/a b',
    repositoryId: 'repo_one',
    accountId: 'account_one',
    bindingRevision: 4,
    primaryRemote: 'upstream',
  };

  it.each([true, false])('preserves explicit boolean evidence %j', async (viewerCanPush) => {
    // Given
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity, isFork: false, upstream: null, viewerCanPush }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    // When
    const result = await api.projectUpstream(context);

    // Then
    expect(Object.hasOwn(result, 'viewerCanPush')).toBe(true);
    expect(result.viewerCanPush).toBe(viewerCanPush);
  });

  it.each(malformedEvidence)('rejects supplied malformed evidence %j', async (viewerCanPush) => {
    // Given
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity, isFork: false, upstream: null, viewerCanPush }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    // When / Then
    await expect(api.projectUpstream(context)).rejects.toThrow('invalid upstream');
  });
});

describe.each(otherProviders)('omitted upstream push evidence for $provider', (identity) => {
  it.each([true, false])('preserves absence when isFork is %j', async (isFork) => {
    // Given
    const context: SourceControlReadContext = {
      ...identity, directory: '/repo', repositoryId: 'repo_one', accountId: 'account_one',
      bindingRevision: 4, primaryRemote: 'origin',
    };
    const upstream = isFork ? {
      ...identity, id: 'team/app', owner: 'team', name: 'app', url: `${identity.instance}/team/app`,
    } : null;
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity, isFork, upstream }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    // When
    const result = await api.projectUpstream(context);

    // Then
    expect(result).toEqual({ identity, isFork, upstream });
    expect(Object.hasOwn(result, 'viewerCanPush')).toBe(false);
  });
});

describe.each(githubInstances)('required upstream push evidence on $instance', (identity) => {
  it('rejects the reply when evidence is absent', async () => {
    // Given
    const context: SourceControlReadContext = {
      ...identity, directory: '/repo', repositoryId: 'repo_one', accountId: 'account_one',
      bindingRevision: 4, primaryRemote: 'origin',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity, isFork: false, upstream: null }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    // When / Then
    await expect(api.projectUpstream(context)).rejects.toThrow('invalid upstream');
  });
});
