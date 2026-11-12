import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { createWebSourceControlAPI } from './source-control';
import { sourceControlProviderListSchema } from '@openchamber/ui/lib/source-control/providers/descriptor';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS } from './source-control-providers';

// The fallback is the published shape; the UI reads it through its schema.
const BUILT_IN_PARSED = sourceControlProviderListSchema.parse(BUILT_IN_SOURCE_CONTROL_PROVIDERS);

const runtimeFetchMock = vi.fn(async (_input: string, _init?: RuntimeFetchOptions): Promise<Response> => Response.json({}));

const lastInstance = (): string | null => {
  const query = runtimeFetchMock.mock.calls.at(-1)?.[1]?.query;
  return query instanceof URLSearchParams ? query.get('instance') : null;
};

afterEach(() => {
  runtimeFetchMock.mockReset();
});

const [, gitlab] = BUILT_IN_SOURCE_CONTROL_PROVIDERS;

describe('web source-control providers', () => {
  it('reads the providers the server serves', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: [{ ...gitlab, label: 'GitLab CE' }] }));
    const providers = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).providers();
    expect(providers.map((provider) => [provider.id, provider.label])).toEqual([['gitlab', 'GitLab CE']]);
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/providers', { headers: { Accept: 'application/json' } });
  });

  it('answers with the built-in GitHub and GitLab descriptors when the server predates the route', async () => {
    runtimeFetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const providers = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).providers();
    expect(providers).toEqual(BUILT_IN_PARSED);
    expect(providers.map((provider) => provider.id)).toEqual(['github', 'gitlab']);
  });

  it('keeps the built-in descriptors valid against the UI schema', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: BUILT_IN_SOURCE_CONTROL_PROVIDERS }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).providers()).resolves.toEqual(BUILT_IN_PARSED);
  });

  it('fails instead of answering an empty list when the read fails or the answer is malformed', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Providers unavailable' }, { status: 503 }));
    await expect(api.providers()).rejects.toThrow('Providers unavailable');
    runtimeFetchMock.mockResolvedValueOnce(Response.json([BUILT_IN_SOURCE_CONTROL_PROVIDERS[0]]));
    await expect(api.providers()).rejects.toThrow();
    // Listed providers none of which can be read are not an empty list.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: [{ id: 'github', label: 'GitHub', iconId: 'github' }] }));
    await expect(api.providers()).rejects.toThrow('no readable provider');
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: [] }));
    await expect(api.providers()).resolves.toEqual([]);
  });

  it('normalizes instances the way the served descriptor says', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const context: SourceControlReadContext = {
      provider: 'gitlab', instance: 'https://GitLab.Example.com:8443/', directory: '/repo', repositoryId: 'repo',
      accountId: 'https://gitlab.example.com:8443#7', bindingRevision: 1, primaryRemote: 'origin',
    };
    runtimeFetchMock.mockImplementation(async () => Response.json({ items: [], page: 1, hasMore: false }));
    await api.issuesList(context);
    expect(lastInstance()).toBe('https://gitlab.example.com:8443');

    // A server that describes the provider's instances as hosts is followed.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: [{ ...gitlab, instances: { ...gitlab?.instances, format: 'host' } }] }));
    await api.providers();
    await expect(api.issuesList(context)).rejects.toThrow('Invalid GitLab instance');
    await api.issuesList({ ...context, instance: 'GitLab.Example.com' });
    expect(lastInstance()).toBe('gitlab.example.com');

    // Restore the built-in description for the other suites in this process.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: BUILT_IN_SOURCE_CONTROL_PROVIDERS }));
    await api.providers();
  });

  it('reads references through the provider route and stamps each item with its provider', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const context: SourceControlReadContext = {
      provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo',
      accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
    };
    const item = { kind: 'issue', number: 1, title: 'Issue', url: 'https://github.com/acme/app/issues/1',
      body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, repo: null, items: [item], cursor: null, hasMore: false, total: 1 }));
    await expect(api.references(context, { kind: 'issue' })).resolves.toMatchObject({ items: [{ ...item, provider: 'github' }] });
    expect(runtimeFetchMock.mock.calls.at(-1)?.[0]).toBe('/api/source-control/github/references');
    await expect(api.referencesAcross?.([context, { ...context, provider: 'gitlab', instance: 'https://gitlab.com' }], { kind: 'issue' }))
      .rejects.toThrow('one provider');
  });
});
