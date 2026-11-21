import React from 'react';
import { z } from 'zod';
import type { SourceControlIdentity } from '@/lib/api/types';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { unknownProviderDescriptor, type ChangeRequestTerm, type SourceControlProviderDescriptor } from './providers/descriptor';
import { useSourceControlProviderRegistry } from './providers/registry';
import { parseRepositoryItemUrl, type RepositoryItemUrlMatch } from './providers/urlMatchers';
import { proxyGuestServiceRequest } from '@/lib/guests/service';

const resolvedUrlSchema = z.object({ url: z.string() }).nullable();

export type RepositoryUrlResolver = {
  provider: string;
  instance: string;
  resolve: () => Promise<RepositoryItemUrlMatch | null>;
};

export interface RepositoryUrlMatcher {
  match: (url: string) => RepositoryItemUrlMatch | null;
  resolverFor?: (url: string) => RepositoryUrlResolver | null;
  descriptorOf: (provider: string) => SourceControlProviderDescriptor;
}

export const createRepositoryUrlMatcher = (
  descriptors: readonly SourceControlProviderDescriptor[],
  knownIdentities: readonly SourceControlIdentity[],
): RepositoryUrlMatcher => {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const match = (url: string) => parseRepositoryItemUrl(url, descriptors, knownIdentities);
  return {
    match,
    resolverFor: (link) => {
      let url: URL;
      try { url = new URL(link); } catch { return null; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      const native = match(link);
      if (native) {
        const nativeDescriptor = byId.get(native.provider);
        const address = nativeDescriptor?.instances.format === 'host' ? url.hostname : url.origin;
        const registered = knownIdentities.find((identity) => identity.provider === native.provider
          && identity.instance === native.instance);
        if (!registered?.instanceAliases?.includes(address)
          && (nativeDescriptor?.instances.defaultInstance === native.instance || registered)) return null;
      }
      for (const identity of knownIdentities) {
        const descriptor = byId.get(identity.provider);
        const path = descriptor?.urls.resolve;
        const guestId = descriptor?.extension?.guestId;
        const instance = descriptor?.instances.format === 'host' ? url.hostname : url.origin;
        if (!descriptor || !path || !guestId || (identity.instance !== instance && !identity.instanceAliases?.includes(instance))) continue;
        return { provider: identity.provider, instance: identity.instance, resolve: async () => {
          const response = await proxyGuestServiceRequest(guestId, {
            method: 'POST', path, body: JSON.stringify({ url: link, instance: identity.instance }),
          });
          if (!response.ok) throw new Error(response.message);
          if (response.result.status !== 200) throw new Error('The URL resolver could not resolve this link');
          const result = resolvedUrlSchema.safeParse(JSON.parse(response.result.body));
          if (!result.success) throw new Error('Invalid resolved URL');
          if (result.data === null) return null;
          const item = parseRepositoryItemUrl(result.data.url, [descriptor], [{ provider: identity.provider, instance: identity.instance }]);
          if (!item || item.provider !== identity.provider || item.instance !== identity.instance) throw new Error('The resolved URL belongs to another provider instance');
          return item;
        } };
      }
      return null;
    },
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
