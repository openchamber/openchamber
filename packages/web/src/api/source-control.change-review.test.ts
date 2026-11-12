import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceControlExistingMutationTarget, SourceControlMutationContext, SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import { changeHostDescriptor } from '@openchamber/ui/lib/source-control/providers/descriptor.fixture';
import { createWebSourceControlAPI } from './source-control';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS } from './source-control-providers';

const runtimeFetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
const identity = { provider: 'review-host', instance: 'https://review.example.com' };
const readContext: SourceControlReadContext = {
  ...identity, directory: '/work/app', repositoryId: 'repo_one', accountId: 'review#7', bindingRevision: 2, primaryRemote: 'origin',
};
const mutationContext: SourceControlMutationContext<SourceControlExistingMutationTarget> = {
  ...readContext, idempotencyKey: 'mutation-1',
  target: { project: { owner: 'acme', name: 'app' }, number: 4321, headSha: 'b'.repeat(40) },
};
const user = (id: string, username: string) => ({ ...identity, id, username });
const project = { ...identity, id: 'acme/app', owner: 'acme', name: 'app', url: 'https://review.example.com/q/project:acme/app' };
const change = {
  ...identity, id: 'acme~app~4321', number: 4321, project, title: 'Login flow', url: 'https://review.example.com/c/acme/app/+/4321',
  state: 'open', draft: true, base: 'main', head: 'refs/changes/21/4321/2', headSha: 'b'.repeat(40),
  workInProgress: true, private: false, topic: 'login', hashtags: ['ui'], revisionNumber: 2,
};
const receipt = (result: { commented: boolean }) => ({
  status: 'succeeded',
  actor: { ...identity, providerAccountId: 'https://review.example.com#7' },
  target: { repositoryId: 'repo_one', bindingRevision: 2, primaryRemote: 'origin', project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 4321, headSha: 'b'.repeat(40) },
  replayed: false,
  result,
});
const voteLabel = {
  name: 'Code-Review', defaultValue: 0, blocking: true, status: 'recommended', permitted: [-1, 0, 1],
  values: [{ value: -1, description: 'Prefer not' }, { value: 0, description: 'No score' }, { value: 1, description: 'Looks good to me' }],
  votes: [{ user: user('9', 'reviewer'), value: 1, revision: 2 }],
};
const contextPayload = () => ({
  identity, project, changeRequest: change, issueComments: [], files: [],
  reviewComments: [{ ...identity, id: '11', url: 'https://review.example.com/c/4321/comment/11', body: 'Nit', path: 'a.ts', line: 3, revision: 1 }],
});

afterEach(() => {
  runtimeFetchMock.mockReset();
});

describe('a change-based review host through the web adapter', () => {
  it('reads a revision of a change, with its votes, submit requirements, revisions and flags', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...contextPayload(),
      voteLabels: [voteLabel],
      submitRequirements: [{ name: 'Code-Review', status: 'unsatisfied', description: 'Needs +2' }],
      revisions: [
        { number: 1, sha: 'a'.repeat(40), createdAt: null, ref: 'refs/changes/21/4321/1', uploader: user('7', 'author') },
        { number: 2, sha: 'b'.repeat(40), createdAt: '2026-10-01T00:00:00Z', ref: 'refs/changes/21/4321/2', kind: 'trivial-rebase' },
      ],
    }));
    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(readContext, 4321, { revision: 'a'.repeat(40) });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/review-host/pulls/context', {
      query: new URLSearchParams({
        instance: 'https://review.example.com', directory: '/work/app', repositoryId: 'repo_one', accountId: 'review#7',
        bindingRevision: '2', primaryRemote: 'origin', number: '4321', revision: 'a'.repeat(40),
      }),
      headers: { Accept: 'application/json' },
    });
    expect(result.changeRequest).toMatchObject({ workInProgress: true, private: false, topic: 'login', hashtags: ['ui'], revisionNumber: 2 });
    expect(result.voteLabels).toEqual([{ ...voteLabel, votes: [{ user: user('9', 'reviewer'), value: 1, revision: 2 }] }]);
    expect(result.submitRequirements).toEqual([{ name: 'Code-Review', status: 'unsatisfied', description: 'Needs +2' }]);
    expect(result.revisions?.map((revision) => [revision.number, revision.kind, revision.uploader?.username])).toEqual([[1, undefined, 'author'], [2, 'trivial-rebase', undefined]]);
    expect(result.reviewComments[0]).toMatchObject({ path: 'a.ts', line: 3, revision: 1 });
  });

  it('leaves the change-review fields out for a host that sends none', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(contextPayload()));
    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(readContext, 4321);
    expect('voteLabels' in result || 'submitRequirements' in result || 'revisions' in result).toBe(false);
  });

  it.each([
    ['a vote out of range', { voteLabels: [{ ...voteLabel, permitted: [11] }] }, 'invalid vote label'],
    ['an unknown vote status', { voteLabels: [{ ...voteLabel, status: 'maybe' }] }, 'invalid vote label'],
    ['an unknown requirement status', { submitRequirements: [{ name: 'Code-Review', status: 'pending' }] }, 'invalid submit requirement'],
    ['an unknown revision kind', { revisions: [{ number: 1, sha: 'a'.repeat(40), createdAt: null, ref: 'refs/changes/21/4321/1', kind: 'squash' }] }, 'invalid revision'],
    ['a revision without a number', { revisions: [{ number: 0, sha: 'a'.repeat(40), createdAt: null, ref: 'r' }] }, 'invalid revision'],
  ])('refuses a context with %s rather than showing part of it', async (_name, extra, message) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...contextPayload(), ...extra }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(readContext, 4321)).rejects.toThrow(message);
  });

  it('reads the branch status\'s local revision and chain', async () => {
    const stack = { number: null, base: 'main', layers: [{ number: 4320, title: 'Base', url: 'https://review.example.com/c/4320', state: 'open', draft: false, head: 'refs/changes/20/4320/1' }] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity, project, branch: 'main', changeRequest: change, localRevision: { sha: 'c'.repeat(40), changeId: `I${'d'.repeat(40)}`, uploadedAs: null }, stack,
    }));
    const status = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestStatus(readContext, 'main');
    expect(status.localRevision).toEqual({ sha: 'c'.repeat(40), changeId: `I${'d'.repeat(40)}`, uploadedAs: null });
    expect(status.stack).toEqual(stack);

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity, project, branch: 'main', changeRequest: null, localRevision: { sha: 'c'.repeat(40), changeId: null, uploadedAs: 0 },
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestStatus(readContext, 'main')).rejects.toThrow('invalid local revision');
  });

  it('sends votes or a verdict, never both, and never an empty vote', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(receipt({ commented: true })));
    await expect(api.changeRequestReview({ ...mutationContext, votes: { 'Code-Review': 1, Verified: -1 }, body: 'Ship it' }))
      .resolves.toMatchObject({ result: { commented: true } });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/review-host/pr/review', expect.objectContaining({
      body: expect.stringContaining('"votes":{"Code-Review":1,"Verified":-1},"body":"Ship it"'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ body: expect.not.stringContaining('verdict') }));

    await expect(api.changeRequestReview({ ...mutationContext, votes: {} })).rejects.toThrow('review input is invalid');
    await expect(api.changeRequestReview({ ...mutationContext, votes: { 'Code-Review': 20 } })).rejects.toThrow('review input is invalid');
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a username with the HTTP password where the provider asks for one', async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ connected: false }));
    await createWebSourceControlAPI({ fetch: runtimeFetchMock }).authSetToken(identity, 'secret', { username: 'alex' });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/review-host/auth/token', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ token: 'secret', username: 'alex' }),
    }));
  });

  it('keeps submit among the merge methods the capabilities name', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity, authentication: true, authenticationMethods: {}, multipleAccounts: true, projects: true, issues: false,
      changeRequests: true, draftChangeRequests: true, mergeChangeRequests: true, mergeMethods: ['submit'], ci: false,
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).capabilities(identity)).resolves.toMatchObject({ mergeMethods: ['submit'] });
  });

  it('reads a top-level project, with the empty owner, only from a path-style provider', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const topLevel = { ...project, id: 'tools', owner: '', name: 'tools' };
    const gitlab = { provider: 'gitlab', instance: 'https://gitlab.com' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ providers: [...BUILT_IN_SOURCE_CONTROL_PROVIDERS, changeHostDescriptor()] }));
    await api.providers();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity, project: topLevel, branch: 'main', changeRequest: null }));
    await expect(api.changeRequestStatus(readContext, 'main')).resolves.toMatchObject({ project: { owner: '', name: 'tools' } });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity: gitlab, project: { ...topLevel, ...gitlab }, branch: 'main', changeRequest: null }));
    await expect(api.changeRequestStatus({ ...readContext, ...gitlab }, 'main')).rejects.toThrow('invalid project');
  });

  it('reads a top-level project from a provider whose descriptor has not been read yet', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const unread = { provider: 'unread-review-host', instance: 'https://unread.example.com' };
    const topLevel = { ...project, ...unread, id: 'tools', owner: '', name: 'tools' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity: unread, project: topLevel, branch: 'main', changeRequest: null }));
    await expect(api.changeRequestStatus({ ...readContext, ...unread }, 'main')).resolves.toMatchObject({ project: { owner: '', name: 'tools' } });
  });
});
