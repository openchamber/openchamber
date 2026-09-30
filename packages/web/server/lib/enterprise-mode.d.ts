export type EnterprisePolicySource = 'policy-file' | 'environment';

export interface EnterprisePolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
}

export interface EnterprisePolicy {
  enterpriseMode: boolean;
  source: EnterprisePolicySource | null;
  organization: string | null;
  policyError: string | null;
  relayUrl: string | null;
  jev: { url: string; model: string | null; apiKey: string | null } | null;
  allowNetworkAccess: boolean;
  allowedExtensions: string[];
  allowLocalExtensions: boolean;
}

export type PublicEnterprisePolicy = Pick<EnterprisePolicy, 'enterpriseMode' | 'source' | 'organization' | 'policyError'> & { networkAccessBlocked: boolean };

export function policyFilePaths(options?: Pick<EnterprisePolicyOptions, 'platform' | 'env'>): string[];
export function readEnterprisePolicy(options?: EnterprisePolicyOptions): EnterprisePolicy;
export function isEnterpriseMode(options?: EnterprisePolicyOptions): boolean;
export function isNetworkAccessBlocked(options?: EnterprisePolicyOptions): boolean;
export const NETWORK_ACCESS_BLOCKED_ERROR: string;
export function publicEnterprisePolicy(options?: EnterprisePolicyOptions): PublicEnterprisePolicy;
export function isProviderConnectRequest(method: string, requestPath: string): boolean;
export const ENTERPRISE_MODE_ERROR: string;
