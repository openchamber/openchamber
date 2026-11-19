import { createGiteaFamilyProvider, GITEA_EDITIONS } from '../gitea/provider.js';
import { forgejoDescriptor } from './descriptor.js';
import type { GiteaFamilyProviderOptions } from '../gitea/provider.js';
import type { ProviderDescriptor } from '../source-control/provider-contract.js';

type Options<Family extends GiteaFamilyProviderOptions> = Family extends GiteaFamilyProviderOptions
  ? Omit<Family, 'descriptor' | 'edition'> & { descriptor?: ProviderDescriptor }
  : never;
export type ForgejoProviderOptions = Options<GiteaFamilyProviderOptions>;

export function createProvider({ descriptor = forgejoDescriptor, ...services }: ForgejoProviderOptions) {
  return createGiteaFamilyProvider({ ...services, descriptor, edition: GITEA_EDITIONS.forgejo });
}
