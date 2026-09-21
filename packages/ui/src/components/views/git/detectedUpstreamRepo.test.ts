import { describe, expect, test } from 'bun:test';
import type { Project, SourceControlReadContext } from '@/lib/api/types';
import { loadDetectedUpstreamRepo } from './detectedUpstreamRepo';

const context: SourceControlReadContext = {
  provider: 'github',
  instance: 'github.com',
  accountId: 'account',
  repositoryId: 'repo',
  bindingRevision: 1,
  directory: '/repo',
  primaryRemote: 'origin',
};

const upstream: Project = {
  provider: 'github',
  instance: 'github.com',
  id: 'upstream/repo',
  owner: 'upstream',
  name: 'repo',
  url: 'https://github.com/upstream/repo',
};

describe('detected upstream loading', () => {
  test('returns authoritative empty state when the project is not a fork', async () => {
    const result = await loadDetectedUpstreamRepo({
      projectUpstream: async () => ({ identity: context, isFork: false, upstream: null }),
      projectBranches: async () => ['unused'],
    }, context);

    expect(result).toEqual({ upstream: null, branches: [] });
  });

  test('returns an authoritative empty branch list', async () => {
    const result = await loadDetectedUpstreamRepo({
      projectUpstream: async () => ({ identity: context, isFork: true, upstream }),
      projectBranches: async () => [],
    }, context);

    expect(result).toEqual({ upstream, branches: [] });
  });

  test('does not turn a transient branch failure into empty success', async () => {
    await expect(loadDetectedUpstreamRepo({
      projectUpstream: async () => ({ identity: context, isFork: true, upstream }),
      projectBranches: async () => { throw new Error('offline'); },
    }, context)).rejects.toThrow('offline');
  });
});
