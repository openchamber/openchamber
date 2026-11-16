import React from 'react';
import type { SourceControlIdentity } from '@/lib/api/types';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { unknownProviderDescriptor, type ChangeRequestTerm, type SourceControlProviderDescriptor } from './providers/descriptor';
import { useSourceControlProviderRegistry } from './providers/registry';
import { parseRepositoryItemUrl, type RepositoryItemUrlMatch } from './providers/urlMatchers';

export interface RepositoryUrlMatcher {
  match: (url: string) => RepositoryItemUrlMatch | null;
  descriptorOf: (provider: string) => SourceControlProviderDescriptor;
}

export const createRepositoryUrlMatcher = (
  descriptors: readonly SourceControlProviderDescriptor[],
  knownIdentities: readonly SourceControlIdentity[],
): RepositoryUrlMatcher => {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return {
    match: (url) => parseRepositoryItemUrl(url, descriptors, knownIdentities),
    descriptorOf: (provider) => byId.get(provider) ?? unknownProviderDescriptor(provider),
  };
};

export const changeRequestTermOfUrl = (url: string, urls: RepositoryUrlMatcher): ChangeRequestTerm => {
  const item = urls.match(url);
  return item ? urls.descriptorOf(item.provider).terminology.changeRequest : 'pullRequest';
};

export const useRepositoryUrlMatcher = (): RepositoryUrlMatcher => {
  const descriptors = useSourceControlProviderRegistry((state) => state.ordered);
  const identities = useSourceControlAuthStore((state) => state.identities);
  return React.useMemo(() => createRepositoryUrlMatcher(descriptors, identities), [descriptors, identities]);
};
