import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import { fetchRepositoryReferenceDetail } from './repository-references';

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo_one',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const ref = { owner: 'gaojunran', repo: 'me', number: 1 };
const payload = <T,>(detail: T) => ({ connected: true, detail });

describe('the reference detail read', () => {
  it('keeps the assignees and the write access the detail carries', async () => {
    const fetch = vi.fn(async () => Response.json(payload({
      number: 1, comments: [], commentTotal: 0, pull: null,
      assignees: [{ id: 'gaojunran', login: 'gaojunran', avatarUrl: 'https://avatars.example/1.png' }],
      writeAccess: false,
    })));

    const result = await fetchRepositoryReferenceDetail(fetch, context, ref);
    if (!result.connected) throw new Error('detail expected');

    expect(result.detail?.assignees).toEqual([{ id: 'gaojunran', login: 'gaojunran', avatarUrl: 'https://avatars.example/1.png' }]);
    expect(result.detail?.writeAccess).toBe(false);
  });

  it('leaves both absent when the host does not report them', async () => {
    const fetch = vi.fn(async () => Response.json(payload({ number: 1, comments: [], commentTotal: 0, pull: null })));

    const result = await fetchRepositoryReferenceDetail(fetch, context, ref);
    if (!result.connected) throw new Error('detail expected');

    expect(result.detail && 'assignees' in result.detail).toBe(false);
    expect(result.detail && 'writeAccess' in result.detail).toBe(false);
  });

  it.each([
    ['an assignee without a login', () => ({ assignees: [{ id: 'gaojunran' }] })],
    ['an assignee whose login is not a string', () => ({ assignees: [{ id: 'gaojunran', login: 1 }] })],
    ['a write access that is not a boolean', () => ({ writeAccess: 'yes' })],
  ])('refuses %s', async (_label, extra) => {
    const fetch = vi.fn(async () => Response.json(payload({ number: 1, comments: [], commentTotal: 0, pull: null, ...extra() })));

    await expect(fetchRepositoryReferenceDetail(fetch, context, ref)).rejects.toBeInstanceOf(ZodError);
  });
});
