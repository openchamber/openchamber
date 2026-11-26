import { describe, expect, it } from 'vitest';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { digestMutationInput } from './mutation-executor.js';
import { SOURCE_CONTROL_MUTATION_KINDS } from './mutation-storage.js';
import { createStandardMutations } from './standard-mutations.js';

const giteaOrigin = 'https://gitea.example.com';
const accountId = 'occred:v1:gitea:one:r1';
const actor = { provider: 'gitea', instance: giteaOrigin, accountId };
const credential = { accountId, credentialRevision: 1 };
const target = {
  repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin',
  project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
};
const numbered = { ...target, number: 5 };

const descriptor = {
  label: 'Forge',
  capabilities: { merge: { methods: ['merge'] } },
  presentation: { features: {} },
  limits: { commentMaxLength: 10, labelsMax: 3, reviewersMax: 2, reviewerId: /^\d+$/ },
};

const prepareWith = (mutations) => (route, input, context = numbered) => mutations.prepare({
  route, input, context: { primaryRemote: 'origin', target: context }, actor, credential,
});

describe('standard mutations', () => {
  it('maps every shell route to its persisted kind, in a fixed order', () => {
    const mutations = createStandardMutations(descriptor);
    const prepare = prepareWith(mutations);
    expect(mutations.routes).toEqual([
      '/pr/create', '/pr/update', '/pr/merge', '/pr/ready', '/pr/draft', '/pr/review', '/pr/review/comment', '/pr/review/comment/update',
      '/pr/review/comment/delete', '/pr/review/discard', '/pr/comment', '/issues/comment', '/issues/update', '/pr/comment/update', '/issues/comment/update',
      '/pr/comment/delete', '/issues/comment/delete',
      '/pr/state', '/issues/state', '/pr/labels', '/issues/labels', '/pr/reviewers',
    ]);
    const inputs = {
      '/pr/create': { title: 'T' }, '/pr/update': { title: 'T' }, '/pr/merge': { method: 'merge' }, '/pr/ready': {}, '/pr/draft': {},
      '/pr/review': { verdict: 'approve' }, '/pr/review/comment': { path: 'a.ts', side: 'new', line: 1, body: 'hi' },
      '/pr/review/comment/update': { commentId: '1', body: 'hi' }, '/pr/review/comment/delete': { commentId: '1' }, '/pr/review/discard': {},
      '/pr/comment': { body: 'hi' }, '/issues/comment': { body: 'hi' }, '/issues/update': { title: 'T', body: 'B' },
      '/pr/comment/update': { commentId: '1', body: 'hi' }, '/issues/comment/update': { commentId: '1', body: 'hi' },
      '/pr/comment/delete': { commentId: '1' }, '/issues/comment/delete': { commentId: '1' },
      '/pr/state': { state: 'closed' }, '/issues/state': { state: 'open' }, '/pr/labels': { labels: ['a'] },
      '/issues/labels': { labels: ['a'] }, '/pr/reviewers': { reviewers: ['1'] },
      '/pr/base': { base: 'develop' }, '/pr/update-branch': { expectedHeadSha: 'a'.repeat(40) },
    };
    const kinds = mutations.routes.map((route) => prepare(route, inputs[route], { ...numbered, headSha: 'a'.repeat(40) }).kind);
    expect(kinds).toEqual([
      'change-request-create', 'change-request-update', 'change-request-merge', 'change-request-ready', 'change-request-draft', 'change-request-review',
      'change-request-review-comment', 'change-request-review-comment-update', 'change-request-review-comment-delete', 'change-request-review-discard',
      'change-request-comment', 'issue-comment', 'issue-update', 'change-request-comment-update', 'issue-comment-update', 'change-request-comment-delete', 'issue-comment-delete',
      'change-request-state', 'issue-state', 'change-request-labels', 'issue-labels',
      'change-request-reviewers',
    ]);
  });

  it('names only kinds the mutation and audit stores accept', () => {
    const inputs = {
      '/pr/create': { title: 'T' }, '/pr/update': { title: 'T' }, '/pr/merge': { method: 'merge' }, '/pr/ready': {}, '/pr/draft': {},
      '/pr/review': { verdict: 'approve' }, '/pr/review/comment': { path: 'a.ts', side: 'new', line: 1, body: 'hi' },
      '/pr/review/comment/update': { commentId: '1', body: 'hi' }, '/pr/review/comment/delete': { commentId: '1' }, '/pr/review/discard': {},
      '/pr/comment': { body: 'hi' }, '/issues/comment': { body: 'hi' }, '/issues/update': { title: 'T' },
      '/pr/comment/update': { commentId: '1', body: 'hi' }, '/issues/comment/update': { commentId: '1', body: 'hi' },
      '/pr/comment/delete': { commentId: '1' }, '/issues/comment/delete': { commentId: '1' },
      '/pr/state': { state: 'closed' }, '/issues/state': { state: 'open' }, '/pr/labels': { labels: ['a'] },
      '/issues/labels': { labels: ['a'] }, '/pr/reviewers': { reviewers: ['1'] }, '/issues/assignees': { assignees: ['1'] },
      '/pr/base': { base: 'develop' }, '/pr/update-branch': { expectedHeadSha: 'a'.repeat(40) },
      '/pr/review/dismiss': { reviewId: '1', message: 'Outdated' },
    };
    for (const entry of [descriptor, giteaDescriptor]) {
      const mutations = createStandardMutations(entry);
      const prepare = prepareWith(mutations);
      for (const route of mutations.routes) {
        expect(SOURCE_CONTROL_MUTATION_KINDS).toContain(prepare(route, inputs[route], { ...numbered, headSha: 'a'.repeat(40) }).kind);
      }
    }
  });

  const branchWriter = { ...descriptor, presentation: { features: { baseChange: true, updateBranch: true, rebase: true } } };

  it('offers each branch write only where the descriptor declares it', () => {
    const plain = createStandardMutations(descriptor);
    for (const route of ['/pr/base', '/pr/update-branch', '/pr/rebase']) {
      expect(plain.routes).not.toContain(route);
      expect(() => prepareWith(plain)(route, {})).toThrow('Source control mutation is unsupported');
    }
    expect(createStandardMutations(branchWriter).routes).toEqual(expect.arrayContaining(['/pr/base', '/pr/update-branch', '/pr/rebase']));
    expect(createStandardMutations({ ...descriptor, presentation: { features: { rebase: true } } }).routes).toContain('/pr/rebase');
  });

  it('normalizes a base change and a branch update, and refuses the rest', () => {
    const prepare = prepareWith(createStandardMutations(branchWriter));
    expect(prepare('/pr/base', { base: '  develop  ' }).input).toEqual({ base: 'develop', digest: { base: 'develop' } });
    expect(prepare('/pr/update-branch', { expectedHeadSha: 'a'.repeat(40) }).input)
      .toEqual({ expectedHeadSha: 'a'.repeat(40), digest: { expectedHeadSha: 'a'.repeat(40) } });

    expect(() => prepare('/pr/base', { base: '   ' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => prepare('/pr/base', { base: 'x'.repeat(300) })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => prepare('/pr/update-branch', { expectedHeadSha: 'A'.repeat(40) })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => prepare('/pr/rebase', { expectedHeadSha: 'a'.repeat(40) }, { ...numbered, headSha: 'c'.repeat(40) }))
      .toThrow('expectedHeadSha does not match the target head');
  });

  it('digests the frozen fields Gitea records replay by', () => {
    const prepare = prepareWith(createStandardMutations(giteaDescriptor));
    expect(prepare('/pr/create', { title: 'Feature' }, target).digest(target))
      .toBe('23035f5a7c84b6b8b9ec44c0d049581892e4d15b5d566ae6f9f8a9041477c3b4');
    expect(prepare('/pr/merge', { method: 'squash' }).digest(numbered))
      .toBe('77bebc0991b4c34029b850ae251f8bbcd80f9821d734c02b447d7fb4aac63ed4');
    expect(prepare('/issues/labels', { labels: ['bug', 'a', 'bug'] }).digest(numbered))
      .toBe('ad9ec5b59683686e705b85b5f6866b1835a6306c81a73fb920bc0724d8890455');
    // The two directions are different mutations under one target.
    expect(prepare('/pr/draft', {}).digest(numbered)).not.toBe(prepare('/pr/ready', {}).digest(numbered));
  });

  it('digests a conversation comment edit by its id and text, and a delete by its id alone', () => {
    const prepare = prepareWith(createStandardMutations(giteaDescriptor));
    expect(prepare('/pr/comment/update', { commentId: '7', body: 'Fixed' }).digest(numbered))
      .toBe(digestMutationInput({
        kind: 'change-request-comment-update', actor, credential, target: numbered, commentId: '7', body: 'Fixed',
      }));
    expect(prepare('/issues/comment/delete', { commentId: '7' }).digest(numbered))
      .toBe(digestMutationInput({
        kind: 'issue-comment-delete', actor, credential, target: numbered, commentId: '7',
      }));
    // An edited body is a different mutation; the same text on a different route is too.
    expect(prepare('/pr/comment/update', { commentId: '7', body: 'Other' }).digest(numbered))
      .not.toBe(prepare('/pr/comment/update', { commentId: '7', body: 'Fixed' }).digest(numbered));
    expect(prepare('/pr/comment/update', { commentId: '7', body: 'Fixed' }).digest(numbered))
      .not.toBe(prepare('/issues/comment/update', { commentId: '7', body: 'Fixed' }).digest(numbered));
  });

  it('digests the same input the same way whatever the descriptor, so the host owns the digest', () => {
    const forge = prepareWith(createStandardMutations(descriptor))('/pr/comment', { body: 'hello' });
    const gitea = prepareWith(createStandardMutations(giteaDescriptor))('/pr/comment', { body: 'hello' });
    expect(forge.digest(numbered)).toBe(gitea.digest(numbered));
    expect(forge.digest(numbered)).toBe(digestMutationInput({ kind: 'change-request-comment', actor, credential, target: numbered, body: 'hello' }));
    expect(forge.digest({ ...numbered, number: 6 })).not.toBe(forge.digest(numbered));
  });

  it('normalizes create input, defaulting both remotes to the primary one', () => {
    const create = prepareWith(createStandardMutations(descriptor))('/pr/create', { title: '  T  ', body: 'b', draft: 'yes', headRemote: ' fork ' }, target);
    expect(create.input).toEqual({
      title: 'T', body: 'b', draft: false, headRemote: 'fork',
      digest: { title: 'T', body: 'b', draft: false, remote: 'origin', headRemote: 'fork' },
    });
  });

  it('sorts and deduplicates label and reviewer sets', () => {
    const prepare = prepareWith(createStandardMutations(descriptor));
    expect(prepare('/pr/labels', { labels: ['b', 'a', 'b'] }).input).toEqual({ names: ['a', 'b'], digest: { labels: ['a', 'b'] } });
    expect(prepare('/pr/reviewers', { reviewers: ['2', '1'] }).input).toEqual({ names: ['1', '2'], digest: { reviewers: ['1', '2'] } });
  });

  it('refuses input outside the descriptor limits and unknown routes', () => {
    const prepare = prepareWith(createStandardMutations(descriptor));
    const refusals = [
      ['/pr/create', { title: '' }, target],
      ['/pr/update', { title: 'T' }, target],
      ['/pr/merge', { method: 'squash' }, numbered],
      ['/pr/ready', {}, target],
      ['/pr/review', { verdict: 'approve' }, numbered],
      ['/pr/comment', { body: 'x'.repeat(11) }, numbered],
      ['/issues/comment', { body: '   ' }, numbered],
      ['/issues/update', { title: '   ' }, numbered],
      ['/issues/update', { title: 'T', body: 5 }, numbered],
      ['/pr/comment/update', { body: 'hi' }, numbered],
      ['/pr/comment/update', { commentId: '', body: 'hi' }, numbered],
      ['/pr/comment/update', { commentId: '1', body: '   ' }, numbered],
      ['/issues/comment/update', { commentId: '1', body: 'x'.repeat(11) }, numbered],
      ['/issues/comment/delete', { commentId: 4 }, numbered],
      ['/issues/comment/delete', {}, numbered],
      ['/issues/state', { state: 'merged' }, numbered],
      ['/issues/state', { state: 'closed', reason: 'not_planned' }, numbered],
      ['/pr/state', { state: 'closed', reason: 'completed' }, numbered],
      ['/pr/labels', { labels: ['a', 'b', 'c', 'd'] }, numbered],
      ['/pr/reviewers', { reviewers: ['alice'] }, numbered],
      ['/pr/thread/reply', {}, numbered],
      ['constructor', {}, numbered],
    ];
    for (const [route, input, context] of refusals) {
      expect(() => prepare(route, input, context), route).toThrow(expect.objectContaining({
        code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400,
      }));
    }
    expect(() => prepare('/pr/comment', { body: 'x'.repeat(11) })).toThrow('must fit a Forge comment');
  });

  describe('votes hosts', () => {
    const votesDescriptor = {
      ...descriptor,
      label: 'Review',
      capabilities: { merge: { methods: ['submit'] }, reviewModel: 'votes' },
      limits: { ...descriptor.limits, commentMaxLength: 100 },
    };
    const reviewAccount = 'occred:v1:review:one:r1';
    const reviewTarget = { ...numbered, headSha: 'a'.repeat(40) };
    delete reviewTarget.head;
    delete reviewTarget.base;
    const prepareVotes = (input, context = reviewTarget) => createStandardMutations(votesDescriptor).prepare({
      route: '/pr/review', input, context: { primaryRemote: 'origin', target: context },
      actor: { provider: 'review', instance: 'https://review.example.com', accountId: reviewAccount },
      credential: { accountId: reviewAccount, credentialRevision: 1 },
    });

    it('takes votes under the review kind with its own frozen digest', () => {
      const prepared = prepareVotes({ votes: { Verified: 1, 'Code-Review': 2 }, body: 'Ship it' });
      expect(prepared.kind).toBe('change-request-review');
      expect(prepared.input).toEqual({
        votes: { Verified: 1, 'Code-Review': 2 }, body: 'Ship it',
        digest: { votes: { Verified: 1, 'Code-Review': 2 }, body: 'Ship it' },
      });
      expect(prepared.digest(reviewTarget)).toBe('461d29165e83c496a567c1f959f5bcc33ca38b9f528f6c04600544c961810046');
      // Key order does not matter: the digest's JSON is canonical.
      expect(prepareVotes({ body: 'Ship it', votes: { 'Code-Review': 2, Verified: 1 } }).digest(reviewTarget)).toBe(prepared.digest(reviewTarget));
    });

    it('accepts votes alone or a message alone', () => {
      expect(prepareVotes({ votes: { 'Code-Review': -1 } }).input.digest).toEqual({ votes: { 'Code-Review': -1 }, body: null });
      expect(prepareVotes({ body: 'A question' }).input.digest).toEqual({ votes: {}, body: 'A question' });
    });

    it.each([
      [{}],
      [{ votes: {} }],
      [{ votes: { '-bad': 1 } }],
      [{ votes: { 'Code Review': 1 } }],
      [{ votes: { 'Code-Review': 11 } }],
      [{ votes: { 'Code-Review': 1.5 } }],
      [{ votes: { 'Code-Review': '+1' } }],
      [{ votes: ['Code-Review'] }],
      [{ votes: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`L${index}`, 0])) }],
      [{ votes: { 'Code-Review': 1 }, body: '   ' }],
    ])('refuses the review %j', (input) => {
      expect(() => prepareVotes(input)).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 }));
    });

    it('refuses votes without the revision they are for', () => {
      expect(() => prepareVotes({ votes: { 'Code-Review': 1 } }, numbered)).toThrow('head SHA');
    });

    it('submits only a named patchset, under the unchanged `{ method }` digest', () => {
      const prepareMerge = (context) => createStandardMutations(votesDescriptor).prepare({
        route: '/pr/merge', input: { method: 'submit' }, context: { primaryRemote: 'origin', target: context },
        actor: { provider: 'review', instance: 'https://review.example.com', accountId: reviewAccount },
        credential: { accountId: reviewAccount, credentialRevision: 1 },
      });
      expect(() => prepareMerge(numbered)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('head SHA') }));
      expect(prepareMerge(reviewTarget).input).toEqual({ method: 'submit', digest: { method: 'submit' } });
    });

    it('refuses a verdict, telling an older client to update', () => {
      expect(() => prepareVotes({ verdict: 'approve' })).toThrow(expect.objectContaining({
        status: 400, message: expect.stringContaining('update the app'),
      }));
    });

    it('refuses votes on a verdict host', () => {
      const prepare = prepareWith(createStandardMutations(descriptor));
      expect(() => prepare('/pr/review', { verdict: 'approve', votes: { 'Code-Review': 1 } }, reviewTarget))
        .toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('not votes') }));
    });
  });
});

describe('standard dismissal entries', () => {
  const others = {
    ...descriptor,
    label: 'Others',
    capabilities: { merge: { methods: ['merge'] }, reviewDismiss: 'others', reviewUndismiss: true },
  };
  const own = {
    ...descriptor,
    label: 'Own',
    capabilities: { merge: { methods: ['merge'] }, reviewDismiss: 'own' },
  };

  it('carries the dismissal modes the descriptor declares', () => {
    const prepareOthers = prepareWith(createStandardMutations(others));
    expect(prepareOthers('/pr/review/dismiss', { reviewId: '7', message: 'Off topic' })).toMatchObject({
      kind: 'change-request-review-dismiss',
      input: { reviewId: '7', dismissed: true, message: 'Off topic', digest: { reviewId: '7', dismissed: true, message: 'Off topic' } },
    });
    expect(prepareOthers('/pr/review/dismiss', { reviewId: 7, dismissed: false }).input).toEqual({
      reviewId: '7', dismissed: false, digest: { reviewId: '7', dismissed: false, message: null },
    });
    expect(() => prepareOthers('/pr/review/dismiss', {})).toThrow('reviewId is required');
    // A guest names its reviews by opaque strings, as the SDK contract allows; they pass unchanged into the digest.
    expect(prepareOthers('/pr/review/dismiss', { reviewId: 'PRR_one', message: 'Off topic' }).input).toMatchObject({
      reviewId: 'PRR_one', digest: { reviewId: 'PRR_one', dismissed: true, message: 'Off topic' },
    });
    for (const reviewId of [' 7', 'a'.repeat(257), 'one\ntwo', '']) {
      expect(() => prepareOthers('/pr/review/dismiss', { reviewId, message: 'Off topic' })).toThrow('reviewId is required');
    }
    // Dismissing someone else's review needs a reason; restoring it does not.
    expect(() => prepareOthers('/pr/review/dismiss', { reviewId: '7' })).toThrow('body is required');
    expect(() => prepareOthers('/pr/review/dismiss', { reviewId: '7', message: '   ' })).toThrow('body is required');
    expect(() => prepareOthers('/pr/review/dismiss', { reviewId: '7', dismissed: 'no' })).toThrow('dismissed is invalid');
    expect(() => prepareWith(createStandardMutations({
      ...others,
      label: 'Plain',
      capabilities: { ...others.capabilities, reviewUndismiss: undefined },
    }))('/pr/review/dismiss', { reviewId: '7', dismissed: false })).toThrow('cannot be undismissed');

    const prepareOwn = prepareWith(createStandardMutations(own));
    expect(prepareOwn('/pr/review/dismiss', {})).toMatchObject({
      kind: 'change-request-review-dismiss',
      input: { dismissed: true, digest: { dismissed: true } },
    });
    expect(() => prepareOwn('/pr/review/dismiss', { reviewId: '7' })).toThrow('without a review id or message');
    expect(() => prepareOwn('/pr/review/dismiss', { message: 'x' })).toThrow('without a review id or message');
    expect(() => prepareOwn('/pr/review/dismiss', { dismissed: false })).toThrow('cannot be undismissed');
  });

  it('omits the entry the descriptor does not offer', () => {
    expect(createStandardMutations(giteaDescriptor).routes).toContain('/pr/review/dismiss');
    expect(createStandardMutations(descriptor).routes).not.toContain('/pr/review/dismiss');
  });
});
