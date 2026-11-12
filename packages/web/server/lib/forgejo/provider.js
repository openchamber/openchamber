import { createGiteaFamilyProvider, GITEA_EDITIONS } from '../gitea/provider.js';
import { forgejoDescriptor } from './descriptor.js';

/**
 * Forgejo as a source-control provider: Gitea's implementation with
 * Forgejo's descriptor, its own account section (`section('forgejo')`) and
 * the Forgejo edition, which accepts only a server whose `/version` is
 * Forgejo's. What was checked against live Forgejo is in `DOCUMENTATION.md`.
 */
export function createProvider({ descriptor = forgejoDescriptor, ...services }) {
  return createGiteaFamilyProvider({ ...services, descriptor, edition: GITEA_EDITIONS.forgejo });
}
