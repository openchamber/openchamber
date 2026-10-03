import type { CredentialEntry, IntegrationInfo, JsonValue } from '@opencode/client';

export type LegacyAuthEntry =
  | { type: 'api'; key: string; metadata?: { [key: string]: JsonValue } }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string };
export type LegacyAuthFile = Record<string, LegacyAuthEntry>;

/** Where credentials come from: the running OpenCode in production, a fixture in tests. */
export type CredentialSource = {
  list: () => Promise<CredentialEntry[]>;
  /** Variable keys by integration id; absent when the environment is unknown. */
  listEnvironmentKeys?: () => Promise<Record<string, string>>;
};

export function configureOpenCodeCredentials(next: CredentialSource | null): void;
export function openCodeCredentialSource(connection: {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getLaunchEnvironment?: () => Record<string, string | undefined> | null;
}): CredentialSource;
export function projectEnvironmentKeys(integrations: IntegrationInfo[], environment: Record<string, string | undefined>): Record<string, string>;
export function projectCredentialEntries(entries: CredentialEntry[]): LegacyAuthFile;
export function readOpenCodeCredentials(): Promise<LegacyAuthFile>;
export function getProviderAuth(providerId: string): Promise<LegacyAuthEntry | null>;
