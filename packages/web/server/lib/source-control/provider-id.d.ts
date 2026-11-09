export function isProviderId(value: string): boolean;
export function isReservedProviderId(value: string): boolean;
export const EXTENSION_PROVIDER_PREFIX: 'ext-';
export function isExtensionProviderId(value: string): boolean;
export function isProviderUserId(provider: string, instance: string, value: string): boolean;
export function extensionProviderId(guestId: string): string | null;
export function isProviderUsername(value: string): boolean;
