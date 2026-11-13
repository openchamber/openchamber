import type { SourceControlProviderDescriptor } from './descriptor';

/** How the provider addresses a change request in text: `#12`, `!12`. */
export const formatChangeRequestReference = (descriptor: SourceControlProviderDescriptor, number: number): string => (
  `${descriptor.terminology.changeRequestPrefix}${number}`
);

/**
 * A change request's short label. Where issues and change requests share a
 * prefix the abbreviation tells them apart ("PR #12"); a prefix of its own
 * already does ("!12").
 */
export const formatChangeRequestLabel = (descriptor: SourceControlProviderDescriptor, number: number): string => {
  const { abbreviation, changeRequestPrefix, issuePrefix } = descriptor.terminology;
  return changeRequestPrefix === issuePrefix
    ? `${abbreviation} ${changeRequestPrefix}${number}`
    : `${changeRequestPrefix}${number}`;
};
