import type { CredentialCreateInput, CredentialEntry, IntegrationInfo, JsonValue } from '@opencode/client';

export type LegacyAuthEntry =
  | { type: 'api'; key: string; metadata?: { [key: string]: JsonValue } }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string; server?: string; orgID?: string };
export type LegacyAuthFile = Record<string, LegacyAuthEntry>;

/** Where credentials come from: the running OpenCode in production, a fixture in tests. */
export type CredentialSource = {
  list: () => Promise<CredentialEntry[]>;
  /** Writes, present on the web server only: `renewStoredLogin` needs both. */
  create?: (input: CredentialCreateInput) => Promise<CredentialEntry>;
  remove?: (credentialID: string) => Promise<void>;
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

/** A browser login as OpenCode stores it, read for an isolated space's gatekeeper. */
export type StoredLogin = {
  methodID: string;
  access: string;
  expires: number;
  metadata: { [key: string]: JsonValue };
};
export function getStoredLogin(integrationID: string): Promise<StoredLogin | null>;

/** What the issuer answers for a refresh token: the new tokens and the login's metadata as the method keeps it. */
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
