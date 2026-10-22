import React from 'react';
import type { SourceControlIdentity } from '@/lib/api/types';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { unknownProviderDescriptor, type SourceControlProviderDescriptor } from './providers/descriptor';
import { useSourceControlProviderRegistry } from './providers/registry';
import { parseRepositoryItemUrl, type RepositoryItemUrlMatch } from './providers/urlMatchers';

/**
 * Reads links as issues and change requests of the connected server's
 * providers, and names the descriptor of a provider id. Non-React code
 * (`lib/linkedIssues.ts`) takes one as a parameter instead of reading the
 * provider registry itself.
 */
export interface RepositoryUrlMatcher {
  match: (url: string) => RepositoryItemUrlMatch | null;
  /** The provider's descriptor; an id the registry does not hold reads as the generic fallback. */
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

/**
 * The matcher for the current runtime's providers and connected instances.
 * One object while neither list changes, so it can sit in the dependencies of
 * the memos that read a session's links.
 */
export const useRepositoryUrlMatcher = (): RepositoryUrlMatcher => {
  const descriptors = useSourceControlProviderRegistry((state) => state.ordered);
  const identities = useSourceControlAuthStore((state) => state.identities);
  return React.useMemo(() => createRepositoryUrlMatcher(descriptors, identities), [descriptors, identities]);
};
