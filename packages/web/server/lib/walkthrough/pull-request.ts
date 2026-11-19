import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import type { Json, ProviderReadContext } from '../source-control/provider-contract.js';
import type { WalkthroughSource } from './contracts.js';

export const supportsChangeRequestPatch = (provider: string) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.changeRequestPatch === true
);

export const supportsChangeRequestRevisions = (provider: string) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.revisions === true
);

export interface ChangeRequestReadInput {
  context: ProviderReadContext | undefined;
  number: number;
  sourceRepo: Extract<WalkthroughSource, { kind: 'pr' }>['sourceRepo'] | null;
  revision?: string;
}

export interface ChangeRequestFileInput extends ChangeRequestReadInput {
  path: string;
  previousPath: string | undefined;
  status: string;
  binary: true | undefined;
}

export interface PullRequestReadOptions {
  allowEmpty?: boolean | undefined;
  sourceRepo?: ChangeRequestReadInput['sourceRepo'];
  revision?: string | undefined;
  readChangeRequestPatch?: ((input: ChangeRequestReadInput) => Promise<Json>) | undefined;
}

export interface PullRequestFileReadOptions extends Omit<PullRequestReadOptions, 'allowEmpty' | 'readChangeRequestPatch'> {
  path: string;
  previousPath?: string | undefined;
  status: string;
  binary?: boolean | undefined;
  readChangeRequestFile?: ((input: ChangeRequestFileInput) => Promise<Json>) | undefined;
}

interface PatchFields {
  patch?: Json;
  meta?: Json;
}

const hasPatchFields = (value: Json): value is Json & PatchFields => value !== null;
const isPatchText = (value: Json | undefined): value is string => typeof value === 'string';

const withRevision = <T extends ChangeRequestReadInput>(input: T, revision: string | undefined) => (revision ? { ...input, revision } : input);

const CHANGE_REQUEST_NOUN = { pullRequest: 'Pull request', mergeRequest: 'Merge request' };

const changeRequestLabel = (provider: string | undefined, number: number) => {
  const descriptor = sourceControlProviderDescriptors.get(provider ?? '');
  const noun = (descriptor && descriptor.terminology.changeRequest !== 'change'
    ? CHANGE_REQUEST_NOUN[descriptor.terminology.changeRequest]
    : undefined) ?? 'Change request';
  return `${noun} ${descriptor?.referencePrefix.changeRequest ?? '#'}${number}`;
};

const unavailable = () => Object.assign(new Error('Change request reads are unavailable'), {
  statusCode: 501,
  code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
});

export async function getPullRequestDiff(_directory: string, number: number, readContext: ProviderReadContext | undefined, {
  allowEmpty = false,
  sourceRepo = null,
  revision,
  readChangeRequestPatch,
}: PullRequestReadOptions = {}) {
  if (!(readChangeRequestPatch instanceof Function)) throw unavailable();
  const result = await readChangeRequestPatch(withRevision({ context: readContext, number, sourceRepo }, revision));
  if (!hasPatchFields(result)) throw new TypeError("Cannot destructure property 'patch' of '(intermediate value)' as it is null.");
  const { patch, meta } = result;
  let empty = false;
  if (!allowEmpty) {
    if (!isPatchText(patch)) {
      if (patch === null || patch === undefined) throw new TypeError(`Cannot read properties of ${patch} (reading 'trim')`);
      throw new TypeError('patch.trim is not a function');
    }
    empty = !patch.trim();
  }
  if (!allowEmpty && empty) {
    throw Object.assign(new Error(`${changeRequestLabel(readContext?.provider, number)} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }
  return { patch, meta };
}

export async function getPullRequestFileContents(_directory: string, number: number, readContext: ProviderReadContext | undefined, {
  path,
  previousPath,
  status,
  sourceRepo = null,
  revision,
  binary = false,
  readChangeRequestFile,
}: PullRequestFileReadOptions) {
  if (!(readChangeRequestFile instanceof Function)) throw unavailable();
  return readChangeRequestFile(withRevision({ context: readContext, number, sourceRepo, path, previousPath, status, binary: binary || undefined }, revision));
}
