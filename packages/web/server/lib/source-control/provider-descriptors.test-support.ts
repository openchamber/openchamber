import { isExtensionProviderId } from './provider-id.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';

export function detachExtensionDescriptors(descriptors = sourceControlProviderDescriptors) {
  for (const { id } of descriptors.list()) {
    if (isExtensionProviderId(id)) descriptors.detachExtension(id);
  }
}
