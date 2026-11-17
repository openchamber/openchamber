import { createGiteaFamilyProvider, GITEA_EDITIONS } from '../gitea/provider.js';
import { forgejoDescriptor } from './descriptor.js';

export function createProvider({ descriptor = forgejoDescriptor, ...services }) {
  return createGiteaFamilyProvider({ ...services, descriptor, edition: GITEA_EDITIONS.forgejo });
}
