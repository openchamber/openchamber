import { createHttpsCredentialReference } from '../git/credential-resolver.js';
import { createHash } from 'node:crypto';

// The agent server fetches for a pull request without a loop id: one ref per pull request, overwritten by each retry.
const pullRemoteName = ({ owner, repo, number }) => `openchamber-fix-${createHash('sha256')
  .update(`${owner}/${repo}#${number}`.toLowerCase()).digest('hex').slice(0, 16)}`;

/** Reuses the repository binding and managed network executor for approval work. */
export const createFixLoopGitServices = ({ bindings, network, resolveAccount }) => ({
  readBinding: bindings.get,
  publish: network.publishApprovedCommit,
  applyReviewOperation: bindings.applyFixLoopReviewOperation,
  admit: bindings.readFixLoopPull,
  fetchHead: async (loop, snapshot) => {
    const sourceRequest = { context: loop.readContext,
      project: { id: `${loop.owner}/${loop.repo}`, owner: loop.owner, name: loop.repo },
      number: loop.number, expectedHeadSha: snapshot.headSha,
      requestedRemoteName: loop.id ? `openchamber-fix-${loop.id.replace('fixloop_', '')}` : pullRemoteName(loop) };
    const source = await bindings.resolveChangeRequestSource(sourceRequest);
    const account = await resolveAccount(source.context);
    if (!account || account.status !== 'valid') throw new Error('PR approval fetch credential is unavailable');
    const credentialId = createHttpsCredentialReference({ provider: source.context.provider, instance: source.context.instance,
      credentialId: account.credentialId, credentialRevision: account.credentialRevision, providerUserId: account.providerUserId });
    const result = await network.transferContributorHead({ directory: loop.directory, sourceRequest, source, credentialId,
      destinationRef: `refs/remotes/${source.requestedRemoteName}/head` });
    if (result.state !== 'succeeded') throw new Error('The exact PR head could not be fetched');
  },
});
