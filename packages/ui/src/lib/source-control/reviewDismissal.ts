import type { SourceControlProviderDescriptor } from './providers/descriptor';

export const reviewDismissMode = (descriptor: SourceControlProviderDescriptor): 'others' | 'own' | null => (
  descriptor.capabilities?.reviewDismiss ?? null
);

export const reviewUndismiss = (descriptor: SourceControlProviderDescriptor): boolean => (
  descriptor.capabilities?.reviewUndismiss === true
);
