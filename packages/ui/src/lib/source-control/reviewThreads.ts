import type { SourceControlProviderDescriptor } from './providers/descriptor';

type ReviewThreadCapability = { start: boolean; reply: boolean; resolve: boolean };

const NOT_DECLARED: ReviewThreadCapability = { start: false, reply: true, resolve: true };

export const reviewThreadCapability = (descriptor: SourceControlProviderDescriptor): ReviewThreadCapability => (
  descriptor.capabilities?.reviewThreads ?? NOT_DECLARED
);

export const reviewDismissMode = (descriptor: SourceControlProviderDescriptor): 'others' | 'own' | null => (
  descriptor.capabilities?.reviewDismiss ?? null
);

export const reviewUndismiss = (descriptor: SourceControlProviderDescriptor): boolean => (
  descriptor.capabilities?.reviewUndismiss === true
);
