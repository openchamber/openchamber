import { isExtensionProviderId } from './provider-id.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';

/**
 * Detaches every extension provider from a descriptor facade, the
 * process-wide one by default. Tests that attach to the singleton call it in
 * `afterEach`, so no extension leaks into another test's provider list.
 */
export function detachExtensionDescriptors(descriptors = sourceControlProviderDescriptors) {
  for (const { id } of descriptors.list()) {
    if (isExtensionProviderId(id)) descriptors.detachExtension(id);
  }
}
