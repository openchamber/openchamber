import { describe, expect, it } from 'vitest';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { digestMutationInput } from './mutation-executor.js';
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
      '/pr/create', '/pr/update', '/pr/merge', '/pr/ready', '/pr/review', '/pr/comment', '/issues/comment',
      '/pr/state', '/issues/state', '/pr/labels', '/issues/labels', '/pr/reviewers',
    ]);
    const inputs = {
      '/pr/create': { title: 'T' }, '/pr/update': { title: 'T' }, '/pr/merge': { method: 'merge' }, '/pr/ready': {},
      '/pr/review': { verdict: 'approve' }, '/pr/comment': { body: 'hi' }, '/issues/comment': { body: 'hi' },
      '/pr/state': { state: 'closed' }, '/issues/state': { state: 'open' }, '/pr/labels': { labels: ['a'] },
      '/issues/labels': { labels: ['a'] }, '/pr/reviewers': { reviewers: ['1'] },
    };
    const kinds = mutations.routes.map((route) => prepare(route, inputs[route], { ...numbered, headSha: 'a'.repeat(40) }).kind);
    expect(kinds).toEqual([
      'change-request-create', 'change-request-update', 'change-request-merge', 'change-request-ready', 'change-request-review',
      'change-request-comment', 'issue-comment', 'change-request-state', 'issue-state', 'change-request-labels', 'issue-labels',
      'change-request-reviewers',
    ]);
  });

  it('digests the frozen fields Gitea records replay by', () => {
    const prepare = prepareWith(createStandardMutations(giteaDescriptor));
    expect(prepare('/pr/create', { title: 'Feature' }, target).digest(target))
      .toBe('23035f5a7c84b6b8b9ec44c0d049581892e4d15b5d566ae6f9f8a9041477c3b4');
    expect(prepare('/pr/merge', { method: 'squash' }).digest(numbered))
      .toBe('77bebc0991b4c34029b850ae251f8bbcd80f9821d734c02b447d7fb4aac63ed4');
    expect(prepare('/issues/labels', { labels: ['bug', 'a', 'bug'] }).digest(numbered))
      .toBe('ad9ec5b59683686e705b85b5f6866b1835a6306c81a73fb920bc0724d8890455');
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
      ['/issues/state', { state: 'merged' }, numbered],
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
});
