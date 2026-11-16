import type { CredentialCreateInput, CredentialEntry, IntegrationInfo, JsonValue, UsageLimitsInfo } from '@opencode/client';

export type LegacyAuthEntry =
  | { type: 'api'; key: string; metadata?: { [key: string]: JsonValue } }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string; server?: string; orgID?: string };
export type LegacyAuthFile = Record<string, LegacyAuthEntry>;

export type CredentialSource = {
  list: () => Promise<CredentialEntry[]>;
  create?: (input: CredentialCreateInput) => Promise<CredentialEntry>;
  remove?: (credentialID: string) => Promise<void>;
  listEnvironmentKeys?: () => Promise<Record<string, string>>;
  readUsageLimits?: () => Promise<UsageLimitsInfo | null>;
};

export function configureOpenCodeCredentials(next: CredentialSource | null): void;
export function openCodeCredentialSource(connection: {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getLaunchEnvironment?: () => Record<string, string | undefined> | null;
  getDefaultDirectory?: () => string | null;
}): CredentialSource;
export function projectEnvironmentKeys(integrations: IntegrationInfo[], environment: Record<string, string | undefined>): Record<string, string>;
export function projectCredentialEntries(entries: CredentialEntry[]): LegacyAuthFile;
export function readOpenCodeCredentials(): Promise<LegacyAuthFile>;
export function getProviderAuth(providerId: string): Promise<LegacyAuthEntry | null>;
export function readOpenCodeUsageLimits(): Promise<UsageLimitsInfo | null>;

export type StoredLogin = {
  methodID: string;
  access: string;
  expires: number;
  metadata: { [key: string]: JsonValue };
};
export function getStoredLogin(integrationID: string): Promise<StoredLogin | null>;

export type ExchangedLogin = {
  access: string;
  refresh: string;
  expires: number;
  metadata?: { [key: string]: JsonValue };
};
export function renewStoredLogin(
  integrationID: string,
  exchange: (login: { methodID: string; refresh: string; metadata: { [key: string]: JsonValue } }) => Promise<ExchangedLogin>,
): Promise<StoredLogin | null>;
