import { isString } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';

export function normalizeSourceControlProviderInstance(provider, instance, descriptors = sourceControlProviderDescriptors) {
  const value = isString(instance) ? instance.trim() : '';
  if (!value) throw new Error('Source control provider instance is required');
  const descriptor = descriptors.get(provider);
  if (!descriptor) throw new Error('Source control provider is unsupported');
  return descriptor.instance.normalize(value);
}
