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
  /** OpenCode CLI path pinned by the policy file; null when nothing is pinned. */
  opencodeBinary: string | null;
  hideBuiltinSkillCatalogs: boolean;
  /** The policy file's raw list of plain-HTTP origins for Git hosting providers; use `allowedInsecureGitOrigins()` for what is actually in force. */
  allowedInsecureGitOrigins: string[];
  /** Raw model catalog URL pinned by the policy file; use `readPinnedModelsDevUrl()` for the validated value. */
  modelsDevUrl: string | null;
  /** Skill catalogs that replace the built-in ones; empty when the policy does not supply any. */
  skillsCatalogSources: Array<{
    id: string;
    label: string;
    description?: string;
    source: string;
    defaultSubpath?: string;
    excludedSkills?: string[];
  }>;
}

export type PublicEnterprisePolicy = Pick<EnterprisePolicy, 'enterpriseMode' | 'source' | 'organization' | 'policyError' | 'opencodeBinary'> & { networkAccessBlocked: boolean };

export function policyFilePaths(options?: Pick<EnterprisePolicyOptions, 'platform' | 'env'>): string[];
export function readEnterprisePolicy(options?: EnterprisePolicyOptions): EnterprisePolicy;
/** The validated model catalog URL pinned by the policy file, or null when unset or malformed. */
export function readPinnedModelsDevUrl(options?: EnterprisePolicyOptions): string | null;
export function isEnterpriseMode(options?: EnterprisePolicyOptions): boolean;
/** The validated set of exact plain-HTTP origins in force: the policy file's list plus, while enterprise mode is off, the user's Settings → Git list; malformed entries are dropped. */
export function allowedInsecureGitOrigins(options?: EnterprisePolicyOptions): Set<string>;
export function isNetworkAccessBlocked(options?: EnterprisePolicyOptions): boolean;
export const NETWORK_ACCESS_BLOCKED_ERROR: string;
export function publicEnterprisePolicy(options?: EnterprisePolicyOptions): PublicEnterprisePolicy;
export function isProviderConnectRequest(method: string, requestPath: string): boolean;
export const ENTERPRISE_MODE_ERROR: string;
export function isCredentialListRequest(method: string, requestPath: string): boolean;
export const CREDENTIAL_LIST_ERROR: string;
