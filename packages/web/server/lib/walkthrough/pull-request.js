import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

/**
 * Change request reads for walkthroughs and the comparison view. Each
 * provider's module owns the account, the project network and the patch
 * shape; the runtime hands in the source-control module's provider-neutral
 * readers (`readChangeRequestPatch`, `readChangeRequestFile`), which dispatch
 * by the validated read context's provider. Without them nothing is served.
 */

/** Whether a provider serves change request patches, which walkthroughs of a change request need. */
export const supportsChangeRequestPatch = (provider) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.changeRequestPatch === true
);

const CHANGE_REQUEST_NOUN = { pullRequest: 'Pull request', mergeRequest: 'Merge request' };

/** "Pull request #12", "Merge request !12", in the provider's own words. */
const changeRequestLabel = (provider, number) => {
  const descriptor = sourceControlProviderDescriptors.get(provider);
  const noun = CHANGE_REQUEST_NOUN[descriptor?.terminology.changeRequest] ?? 'Change request';
  return `${noun} ${descriptor?.referencePrefix.changeRequest ?? '#'}${number}`;
};

const unavailable = () => Object.assign(new Error('Change request reads are unavailable'), {
  statusCode: 501,
  code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
});

/**
 * Raw unified diff for a change request (`{ patch, meta }`). An empty diff is
 * a missing change request, not an empty review, unless `allowEmpty` lets the
 * comparison view show a change request that has no diff yet.
 */
export async function getPullRequestDiff(_directory, number, readContext, {
  allowEmpty = false,
  sourceRepo = null,
  readChangeRequestPatch,
} = {}) {
  if (!(readChangeRequestPatch instanceof Function)) throw unavailable();
  const { patch, meta } = await readChangeRequestPatch({ context: readContext, number, sourceRepo });
  if (!allowEmpty && !patch.trim()) {
    throw Object.assign(new Error(`${changeRequestLabel(readContext?.provider, number)} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }
  return { patch, meta };
}

/** Both sides of one file of a change request (`{ original, modified }`), for expanding collapsed context. */
export async function getPullRequestFileContents(_directory, number, readContext, {
  path,
  previousPath,
  status,
  sourceRepo = null,
  readChangeRequestFile,
}) {
  if (!(readChangeRequestFile instanceof Function)) throw unavailable();
  return readChangeRequestFile({ context: readContext, number, sourceRepo, path, previousPath, status });
}
