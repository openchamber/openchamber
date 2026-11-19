import type { JsonValue } from '../../utils/contracts.js';

export const ANTIGRAVITY_CLIENT_VERSION: string;

export function antigravityUserAgent(platform?: string, arch?: string): string;

export function antigravityHeaders(): {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
};

export function warnIfGeminiGroupMissing(
  summaryPayload: JsonValue,
  warn?: (message: string) => void,
): void;
