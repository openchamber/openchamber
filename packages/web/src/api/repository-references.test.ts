import { describe, expect, it, vi } from 'vitest';

import type { RepositoryReferenceDetail, SourceControlReferenceLink, SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { fetchRepositoryReferenceDetail } from './repository-references';

const identity = { provider: 'github' as const, instance: 'github.com' };
const context: SourceControlReadContext = {
  ...identity,
  directory: '/repo',
  repositoryId: 'repo-1',
  accountId: 'github.com#1',
  bindingRevision: 1,
  primaryRemote: 'origin',
};

type WireReviewer = { id: string; login: string; state: string; avatarUrl?: string };
type WirePull = {
  reviewDecision: null;
  reviewers: { id: string; login: string; avatarUrl?: string }[];
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewerStates?: WireReviewer[];
};

const pull = (reviewerStates?: WireReviewer[]): WirePull => {
  const detail: WirePull = { reviewDecision: null, reviewers: [], additions: 0, deletions: 0, changedFiles: 0 };
  if (reviewerStates !== undefined) detail.reviewerStates = reviewerStates;
  return detail;
};
const answer = (pullDetail: WirePull) => ({
  connected: true,
  detail: { number: 9, comments: [], commentTotal: 0, pull: pullDetail },
});
const read = (payload: ReturnType<typeof answer>) => fetchRepositoryReferenceDetail(
  async () => Response.json(payload),
  context,
  { owner: 'acme', repo: 'app', number: 9 },
);

describe('repository reference detail parsing', () => {
  it('keeps per-person reviewer state through the wire schema', async () => {
    const result = await read(answer(pull([
      { id: '9', login: 'ann', avatarUrl: 'https://avatars/ann', state: 'approved' },
      { id: '10', login: 'bo', state: 'pending' },
    ])));
    if (!result.connected || !result.detail?.pull) throw new Error('expected a pull detail');
    expect(result.detail.pull.reviewerStates).toEqual([
      { id: '9', login: 'ann', avatarUrl: 'https://avatars/ann', state: 'approved' },
      { id: '10', login: 'bo', state: 'pending' },
    ]);
  });

  it('leaves an absent field absent rather than empty', async () => {
    const result = await read(answer(pull()));
    if (!result.connected || !result.detail?.pull) throw new Error('expected a pull detail');
    expect(result.detail.pull).not.toHaveProperty('reviewerStates');
  });

  it('skips a state it does not know and keeps the rest of the preview', async () => {
    const result = await read(answer(pull([
      { id: '9', login: 'ann', state: 'rejected' },
      { id: '10', login: 'bo', state: 'approved' },
    ])));
    if (!result.connected || !result.detail?.pull) throw new Error('expected a pull detail');
    expect(result.detail.pull.reviewerStates).toEqual([{ id: '10', login: 'bo', state: 'approved' }]);
  });
});

const item = { owner: 'gaojunran', repo: 'me', number: 2 };

const reference: SourceControlReferenceLink = {
  kind: 'issue', number: 5, title: 'The header story', url: 'https://github.com/gaojunran/me/issues/5',
  repo: 'gaojunran/me', createdAt: '2026-11-12T16:47:27Z', author: { login: 'gaojunran' }, willCloseTarget: false,
};

type DetailPayload = { connected: true; detail: RepositoryReferenceDetail };

const detail = (overrides: Partial<RepositoryReferenceDetail> = {}): DetailPayload => ({
  connected: true,
  detail: { number: 2, comments: [], commentTotal: 0, pull: null, ...overrides },
});

const fetchOf = (body: string) => vi.fn(async (_input: string, _init?: RuntimeFetchOptions) => new Response(body, { headers: { 'Content-Type': 'application/json' } }));

const readWith = (payload: DetailPayload) => (
  fetchRepositoryReferenceDetail(fetchOf(JSON.stringify(payload)), context, item)
);

const readRaw = (body: string) => fetchRepositoryReferenceDetail(fetchOf(body), context, item);

describe('reference detail references', () => {
  it('keeps the cross-references the detail names', async () => {
    const result = await readWith(detail({ references: [reference] }));
    if (!result.connected) throw new Error('expected a connected read');
    expect(result.detail?.references).toEqual([reference]);
  });

  it('asks for cross-references only when the caller does', async () => {
    const asked = fetchOf(JSON.stringify(detail()));
    await fetchRepositoryReferenceDetail(asked, context, item, { includeReferences: true });
    expect(String(asked.mock.calls[0]?.[1]?.query)).toContain('references=1');
    const plain = fetchOf(JSON.stringify(detail()));
    await fetchRepositoryReferenceDetail(plain, context, item);
    expect(String(plain.mock.calls[0]?.[1]?.query)).not.toContain('references=1');
  });

  it('leaves the key absent when the detail names none', async () => {
    const result = await readWith(detail());
    if (!result.connected) throw new Error('expected a connected read');
    expect(result.detail).not.toHaveProperty('references');
  });

  it('drops a malformed cross-reference without failing the rest of the read', async () => {
    const raw = (references: unknown) => readRaw(JSON.stringify({ connected: true, detail: {
      number: 2, comments: [], commentTotal: 0, pull: null, references,
    } }));
    const badKind = await raw([{ ...reference, kind: 'sticky' }]);
    expect(badKind.connected && badKind.detail).not.toHaveProperty('references');
    const badNumber = await raw([{ ...reference, number: '5' }]);
    expect(badNumber.connected && badNumber.detail).not.toHaveProperty('references');
    const badUrl = await raw([{ ...reference, url: 'ftp://example.test/5' }]);
    expect(badUrl.connected && badUrl.detail).not.toHaveProperty('references');
    const notAList = await raw({});
    expect(notAList.connected).toBe(true);
    const mixed = await raw([{ ...reference, kind: 'sticky' }, reference]);
    if (!mixed.connected || mixed.detail === null) throw new Error('expected a connected read');
    expect(mixed.detail.references).toEqual([reference]);
  });
});
