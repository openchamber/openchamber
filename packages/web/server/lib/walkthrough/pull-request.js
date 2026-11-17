import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

export const supportsChangeRequestPatch = (provider) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.changeRequestPatch === true
);

export const supportsChangeRequestRevisions = (provider) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.revisions === true
);

const withRevision = (input, revision) => (revision ? { ...input, revision } : input);

const CHANGE_REQUEST_NOUN = { pullRequest: 'Pull request', mergeRequest: 'Merge request' };

const changeRequestLabel = (provider, number) => {
  const descriptor = sourceControlProviderDescriptors.get(provider);
  const noun = CHANGE_REQUEST_NOUN[descriptor?.terminology.changeRequest] ?? 'Change request';
  return `${noun} ${descriptor?.referencePrefix.changeRequest ?? '#'}${number}`;
};

const unavailable = () => Object.assign(new Error('Change request reads are unavailable'), {
  statusCode: 501,
  code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
});

export async function getPullRequestDiff(_directory, number, readContext, {
  allowEmpty = false,
  sourceRepo = null,
  revision,
  readChangeRequestPatch,
} = {}) {
  if (!(readChangeRequestPatch instanceof Function)) throw unavailable();
  const { patch, meta } = await readChangeRequestPatch(withRevision({ context: readContext, number, sourceRepo }, revision));
  if (!allowEmpty && !patch.trim()) {
    throw Object.assign(new Error(`${changeRequestLabel(readContext?.provider, number)} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }
  return { patch, meta };
}

export async function getPullRequestFileContents(_directory, number, readContext, {
  path,
  previousPath,
  status,
  sourceRepo = null,
  revision,
  binary = false,
  readChangeRequestFile,
}) {
  if (!(readChangeRequestFile instanceof Function)) throw unavailable();
  return readChangeRequestFile(withRevision({ context: readContext, number, sourceRepo, path, previousPath, status, binary: binary || undefined }, revision));
}
