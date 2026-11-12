import { describe, expect, it, vi } from 'vitest';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { createProviderDescriptors } from '../source-control/provider-descriptors.js';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { createNetworkOperationPlanner, isChangeReviewRemote } from './network-operation-plan.js';

/**
 * A change host (createVia: 'push') takes a new change as a push to
 * `refs/for/<branch>` and serves revisions at `refs/changes/NN/N/P`. The
 * planner opens both only on the primary remote of a ready association with
 * such a host, and writes the review refspec itself.
 */
const SHA = 'a'.repeat(40);
const ENDPOINT = 'https://review.example.com/project';
const changeHost = Object.freeze({
  ...giteaDescriptor,
  id: 'review',
  label: 'Review',
  capabilities: { ...giteaDescriptor.capabilities, merge: { methods: ['submit'] }, createVia: 'push', reviewModel: 'votes', revisions: true },
});
const providers = createProviderDescriptors([giteaDescriptor, changeHost]);
const authority = {
  endpoint: ENDPOINT,
  endpointFingerprint: fingerprintRemoteUrl(ENDPOINT),
  transportMode: 'managed',
  credentialId: 'credential_one',
  transportRevision: 'transport_one',
  primaryOf: ['review'],
};
const remote = { name: 'origin', endpoint: { displayUrl: ENDPOINT, fingerprint: authority.endpointFingerprint } };
const reviewInput = (review = { target: 'main' }, overrides = {}) => ({
  operation: 'push', directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one',
  remote, sourceRef: 'refs/heads/feature', transportMode: 'managed', review, ...overrides,
});
const makePlanner = (overrides = {}) => createNetworkOperationPlanner({
  validateGitTransportContext: vi.fn(async () => authority),
  sourceControlProviders: providers,
  resolveRef: vi.fn(async () => SHA),
  checkBranchName: vi.fn(async (_directory, name) => name),
  runtimeIdentity: { id: 'server_one', platform: 'web' },
  idFactory: () => 'git_operation_one',
  ...overrides,
});

describe('review refs on a change host', () => {
  it('pushes for review with a refspec the server composes, recording only the destination ref', async () => {
    const checkBranchName = vi.fn(async (_directory, name) => name);
    const plans = await makePlanner({ checkBranchName }).planNetworkOperation(reviewInput({
      target: 'release/1.0', topic: 'faster-sync', wip: true, private: true, hashtags: ['perf', 'sync', 'perf'],
    }));
    expect(plans.internalPlan.pushRefspec).toBe(`${SHA}:refs/for/release/1.0%topic=faster-sync,wip,private,t=perf,t=sync`);
    expect(plans.publicPlan.target).toEqual({
      operation: 'push', repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one',
      remote, destinationRef: 'refs/for/release/1.0', sourceRef: 'refs/heads/feature',
    });
    // Options never reach the public plan, so neither storage nor the audit sees them.
    expect(JSON.stringify(plans.publicPlan)).not.toContain('faster-sync');
    expect(plans.publicPlan.target).not.toHaveProperty('configureUpstream');
    expect(checkBranchName).toHaveBeenCalledWith('/repository', 'release/1.0');
  });

  it('accepts the destination echoed exactly as the target\'s refs/for ref', async () => {
    const plans = await makePlanner().planNetworkOperation(reviewInput({ target: 'main' }, { destinationRef: 'refs/for/main' }));
    expect(plans.publicPlan.target.destinationRef).toBe('refs/for/main');
    expect(plans.internalPlan.pushRefspec).toBe(`${SHA}:refs/for/main`);
  });

  it('sends a bare refs/for push when no option is set', async () => {
    const plans = await makePlanner().planNetworkOperation(reviewInput({ target: 'main', wip: false }));
    expect(plans.internalPlan.pushRefspec).toBe(`${SHA}:refs/for/main`);
  });

  it.each([
    ['a remote that is no change host\'s primary remote', { ...authority, primaryOf: undefined }],
    ['the primary remote of a host that creates by API', { ...authority, primaryOf: ['gitea'] }],
    ['a provider this build does not know', { ...authority, primaryOf: ['sourcehut'] }],
  ])('refuses review refs on %s', async (_name, current) => {
    const planner = makePlanner({ validateGitTransportContext: vi.fn(async () => current) });
    await expect(planner.planNetworkOperation(reviewInput())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(planner.planNetworkOperation({
      operation: 'fetch', directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one',
      remote, sourceRef: 'refs/changes/45/12345/3', destinationRef: 'refs/remotes/origin/change-12345', transportMode: 'managed',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each([
    [{ target: 'main%topic=x' }],
    [{ target: 'main,wip' }],
    [{ target: '-main' }],
    [{ target: 'main..x' }],
    [{ target: ' main' }],
    [{ target: 'main', topic: 'two words' }],
    [{ target: 'main', topic: 'a,b' }],
    [{ target: 'main', topic: 'x%y' }],
    [{ target: 'main', topic: '' }],
    [{ target: 'main', hashtags: ['ok', 'not ok'] }],
    [{ target: 'main', hashtags: Array.from({ length: 17 }, (_, index) => `t${index}`) }],
    [{ target: 'main', wip: 'yes' }],
    [{ target: 'main', reviewers: ['a'] }],
    [{}],
  ])('refuses the review options %j', async (review) => {
    await expect(makePlanner().planNetworkOperation(reviewInput(review))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('refuses a target Git does not accept as a branch name', async () => {
    const planner = makePlanner({ checkBranchName: vi.fn(async () => null) });
    await expect(planner.planNetworkOperation(reviewInput({ target: 'main' }))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it.each([
    ['a destination ref other than the target\'s', { destinationRef: 'refs/for/other' }],
    ['a branch destination', { destinationRef: 'refs/heads/main' }],
    ['a force lease', { forceWithLease: { expectedRemoteSha: SHA } }],
    ['an upstream write', { configureUpstream: true }],
    ['a destination selection', { destinationSelectionId: 'selection' }],
    ['a tag source', { sourceRef: 'refs/tags/v1' }],
  ])('refuses %s on a push for review', async (_name, overrides) => {
    const validateGitTransportContext = vi.fn(async () => authority);
    await expect(makePlanner({ validateGitTransportContext }).planNetworkOperation(reviewInput({ target: 'main' }, overrides)))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    expect(validateGitTransportContext).not.toHaveBeenCalled();
  });

  it('never takes refs/for as a destination of an ordinary push', async () => {
    const input = { ...reviewInput(), destinationRef: 'refs/for/main' };
    delete input.review;
    await expect(makePlanner().planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('fetches a revision ref from the change host\'s primary remote, and only a well-formed one', async () => {
    const fetchInput = (sourceRef) => ({
      operation: 'fetch', directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one',
      remote, sourceRef, destinationRef: 'refs/remotes/origin/change-12345', transportMode: 'managed',
    });
    const plans = await makePlanner().planNetworkOperation(fetchInput('refs/changes/45/12345/3'));
    expect(plans.publicPlan.target.sourceRef).toBe('refs/changes/45/12345/3');
    expect(plans.internalPlan.changeReviewRemote).toBe(true);
    await expect(makePlanner().planNetworkOperation(fetchInput('refs/changes/07/7/1'))).resolves.toBeTruthy();
    for (const ref of ['refs/changes/44/12345/3', 'refs/changes/45/12345', 'refs/changes/45/12345/meta', 'refs/changes/45/012345/3']) {
      await expect(makePlanner().planNetworkOperation(fetchInput(ref))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    }
  });

  it('keeps ordinary pushes and fetches unchanged on a change host', async () => {
    const plain = { ...reviewInput(), destinationRef: 'refs/heads/feature' };
    delete plain.review;
    const plans = await makePlanner().planNetworkOperation(plain);
    expect(plans.internalPlan).not.toHaveProperty('pushRefspec');
    expect(plans.internalPlan).not.toHaveProperty('changeReviewRemote');
  });

  it('decides the gate from the association and the provider\'s descriptor alone', () => {
    expect(isChangeReviewRemote({ primaryOf: ['review'] }, providers)).toBe(true);
    expect(isChangeReviewRemote({ primaryOf: ['gitea', 'review'] }, providers)).toBe(true);
    expect(isChangeReviewRemote({ primaryOf: ['gitea'] }, providers)).toBe(false);
    expect(isChangeReviewRemote({}, providers)).toBe(false);
  });

  describe('a change host on plain HTTP loopback', () => {
    const loopbackAuthority = (endpoint) => ({ ...authority, endpoint, endpointFingerprint: fingerprintRemoteUrl(endpoint) });
    const loopbackInput = (endpoint) => reviewInput({ target: 'main' }, {
      remote: { name: 'origin', endpoint: { displayUrl: endpoint, fingerprint: fingerprintRemoteUrl(endpoint) } },
    });

    it.each(['http://localhost:8080/demo', 'http://127.0.0.1:8080/team/app', 'http://[::1]:8080/demo'])('pushes for review to %s', async (endpoint) => {
      const plans = await makePlanner({ validateGitTransportContext: vi.fn(async () => loopbackAuthority(endpoint)) })
        .planNetworkOperation(loopbackInput(endpoint));
      expect(plans.internalPlan.rawEndpoint).toBe(endpoint);
    });

    it('never sends plain HTTP to another host, nor where no provider allows loopback HTTP', async () => {
      const remoteHost = 'http://review.example.com/demo';
      await expect(makePlanner({ validateGitTransportContext: vi.fn(async () => loopbackAuthority(remoteHost)) })
        .planNetworkOperation(loopbackInput(remoteHost))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
      const strict = createProviderDescriptors([{
        ...changeHost, presentation: { ...changeHost.presentation, instances: { ...changeHost.presentation.instances, allowLoopbackHttp: false } },
      }]);
      const local = 'http://localhost:8080/demo';
      await expect(makePlanner({ sourceControlProviders: strict, validateGitTransportContext: vi.fn(async () => loopbackAuthority(local)) })
        .planNetworkOperation(loopbackInput(local))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    });
  });
});

