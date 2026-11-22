import type { SourceControlProviderDescriptor } from './descriptor';

export const formatChangeRequestReference = (descriptor: SourceControlProviderDescriptor, number: number): string => (
  `${descriptor.terminology.changeRequestPrefix}${number}`
);

export const formatChangeRequestLabel = (descriptor: SourceControlProviderDescriptor, number: number): string => {
  const { abbreviation, changeRequestPrefix, issuePrefix } = descriptor.terminology;
  return changeRequestPrefix === issuePrefix
    ? `${abbreviation} ${changeRequestPrefix}${number}`
    : `${changeRequestPrefix}${number}`;
};
