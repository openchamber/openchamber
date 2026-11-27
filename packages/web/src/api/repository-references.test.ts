import { describe, expect, it, vi } from 'vitest';

import type { RepositoryReferenceDetail, SourceControlReferenceLink, SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { fetchChangeRequestReviewState, fetchRepositoryReferenceDetail } from './repository-references';

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

  it('keeps the thread-availability flag through the wire schema', async () => {
    const result = await fetchRepositoryReferenceDetail(
      async () => Response.json({ connected: true, detail: { number: 9, comments: [], commentTotal: 0, pull: pull(), threadsUnavailable: true } }),
      context,
      { owner: 'acme', repo: 'app', number: 9 },
    );
    if (!result.connected || !result.detail) throw new Error('expected a detail');
    expect(result.detail.threadsUnavailable).toBe(true);
  });

  it('leaves the thread-availability flag absent when the host did not send it', async () => {
    const result = await read(answer(pull()));
    if (!result.connected || !result.detail) throw new Error('expected a detail');
    expect(result.detail).not.toHaveProperty('threadsUnavailable');
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

const pullItem = { owner: 'acme', repo: 'app', number: 12 };

type ReviewWire = { id: string; state: string; author?: { login: string } | null; submittedAt: string | null };
type ThreadWire = { id: string; resolved: boolean; canResolve: boolean; canReply: boolean; outdated?: boolean; replies: never[] };
type PullWire = {
  reviewDecision: 'approved' | 'changes_requested' | 'review_required';
  reviewers: never[];
  reviews?: ReviewWire[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: never[];
  commitTotal: number;
};
type ReviewStateThreadWire = {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number | null;
  startLine: number | null;
  resolved: boolean;
  canReply: boolean;
  canResolve: boolean;
  comments: never[];
};

const review: ReviewWire = { id: 'R1', state: 'approved', author: { login: 'hubot' }, submittedAt: '2026-01-02T00:00:00Z' };

type DetailOptions = { withReviews?: boolean; emptyReviews?: boolean; topLevelReviews?: boolean; review?: ReviewWire; extraReviews?: ReviewWire[] };

const detailPayload = (options: DetailOptions = {}) => {
  const thread: ThreadWire = { id: 'T1', resolved: false, canResolve: true, canReply: true, replies: [] };
  const pull: PullWire = {
    reviewDecision: 'changes_requested',
    reviewers: [],
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    commits: [],
    commitTotal: 0,
  };
  if (options.emptyReviews === true) pull.reviews = [];
  else if (options.withReviews !== false && options.topLevelReviews !== true) pull.reviews = [options.review ?? review, ...(options.extraReviews ?? [])];
  const detail = {
    number: 12,
    comments: [
      {
        author: { login: 'mona' },
        body: 'Needs a test',
        createdAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/acme/app/pull/12#c1',
        path: 'src/login.ts',
        line: 12,
        review: 'commented',
        thread,
      },
    ],
    commentTotal: 1,
    pull,
  };
  if (options.topLevelReviews === true) Object.assign(detail, { reviews: [options.review ?? review] });
  return { connected: true as const, detail };
};

const reviewStatePayload = () => {
  const thread: ReviewStateThreadWire = {
    id: 'T1',
    path: 'src/login.ts',
    side: 'new',
    line: 12,
    startLine: null,
    resolved: false,
    canReply: true,
    canResolve: true,
    comments: [],
  };
  return { connected: true as const, viewerIsAuthor: false, headSha: 'f'.repeat(40), draft: null, threads: [thread], truncated: false };
};

const answerWith = <T,>(payload: T) => vi.fn(async () => Response.json(payload));

const readDetail = async (payload: ReturnType<typeof detailPayload>) => {
  const result = await fetchRepositoryReferenceDetail(answerWith(payload), context, pullItem);
  if (!result.connected || !result.detail?.pull) throw new Error('Expected a connected detail with a pull');
  return result.detail;
};

describe('reading a change request detail', () => {
  it("keeps the host's reviews", async () => {
    const detail = await readDetail(detailPayload());
    expect(detail.pull?.reviews).toEqual([review]);
  });

  it('leaves reviews outside pull out of the preview', async () => {
    const detail = await readDetail(detailPayload({ topLevelReviews: true }));
    expect('reviews' in (detail.pull ?? {})).toBe(false);
  });

  it('leaves absent reviews absent, never defaulted', async () => {
    const detail = await readDetail(detailPayload({ withReviews: false }));
    expect('reviews' in (detail.pull ?? {})).toBe(false);
  });

  it('drops a review whose state the client does not know, and keeps the rest', async () => {
    const detail = await readDetail(detailPayload({ extraReviews: [{ id: 'R2', state: 'approved-ish', author: { login: 'hubot' }, submittedAt: null }] }));
    expect(detail.pull?.reviews).toEqual([review]);
  });

  it('drops a review with no author field at all, and keeps the rest', async () => {
    const detail = await readDetail(detailPayload({ extraReviews: [{ id: 'R2', state: 'approved', submittedAt: null }] }));
    expect(detail.pull?.reviews).toEqual([review]);
  });

  it('calls an answer no entry holds together unknown, not empty', async () => {
    const detail = await readDetail(detailPayload({ review: { id: 'R1', state: 'approved-ish', author: { login: 'hubot' }, submittedAt: null } }));
    expect('reviews' in (detail.pull ?? {})).toBe(false);
  });

  it('keeps a truly empty answer empty', async () => {
    const detail = await readDetail(detailPayload({ emptyReviews: true }));
    expect(detail.pull?.reviews).toEqual([]);
  });

  it('calls a reviews field that is not a list unknown and keeps the comments and checks beside it', async () => {
    const payload = detailPayload({ withReviews: false });
    Object.assign(payload.detail.pull, { reviews: { id: 'R1' }, checks: { state: 'success', total: 1, success: 1, failure: 0, pending: 0 } });
    const detail = await readDetail(payload);
    expect('reviews' in (detail.pull ?? {})).toBe(false);
    expect(detail.comments).toHaveLength(1);
    expect(detail.pull?.checks).toBeTruthy();
  });
});

describe('reading a change request review', () => {
  it('reads a connected review state', async () => {
    const result = await fetchChangeRequestReviewState(answerWith(reviewStatePayload()), context, pullItem);
    if (!result.connected) throw new Error('Expected a connected review');
    expect(result.threads).toHaveLength(1);
  });
});
