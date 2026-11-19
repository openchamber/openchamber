
import { OpenCode } from '@opencode/client';
import type { CredentialCreateInput, CredentialEntry, CredentialOAuth, CredentialValue, IntegrationInfo, JsonValue, UsageLimitsInfo } from '@opencode/client';
import { z } from 'zod';

export type LegacyAuthEntry =
  | { type: 'api'; key: string; metadata?: { [key: string]: JsonValue } }
  | { type: 'oauth'; access: string | undefined; refresh: string | undefined; expires: number | undefined; accountId?: string; enterpriseUrl?: string; server?: string; orgID?: string };
export type LegacyAuthFile = Record<string, LegacyAuthEntry>;

type Metadata = NonNullable<CredentialOAuth['metadata']>;
type OAuthCreateInput = Omit<CredentialCreateInput, 'value'> & {
  value: Omit<Extract<CredentialCreateInput['value'], { type: 'oauth' }>, 'metadata'> & { metadata?: Metadata | undefined };
};
type OAuthEntry = CredentialEntry & { value: CredentialOAuth };
interface CreateCredential {
  (input: OAuthCreateInput): Promise<OAuthEntry>;
  (input: CredentialCreateInput): Promise<CredentialEntry>;
}
export interface CredentialSource {
  list: () => Promise<CredentialEntry[]>;
  create?: CreateCredential;
  remove?: (credentialID: string) => Promise<void>;
  listEnvironmentKeys?: () => Promise<Record<string, string>>;
  readUsageLimits?: () => Promise<UsageLimitsInfo | null>;
}

interface CredentialConnection {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getLaunchEnvironment?: () => NodeJS.ProcessEnv | null;
  getDefaultDirectory?: () => string | null;
}

let source: CredentialSource | null = null;

export function configureOpenCodeCredentials(next: CredentialSource | null) {
  source = next ?? null;
}

export const projectEnvironmentKeys = (integrations: IntegrationInfo[], environment: NodeJS.ProcessEnv) => {
  const result: Record<string, string> = {};
  for (const integration of integrations) {
    for (const connection of integration.connections) {
      if (connection.type !== 'env' || integration.id in result) continue;
      const key = (environment[connection.name] ?? '').trim();
      if (key) result[integration.id] = key;
    }
  }
  return result;
};

export const openCodeCredentialSource = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getLaunchEnvironment = () => null,
  getDefaultDirectory = () => null,
}: CredentialConnection) => {
  const client = (directory: string | null = null) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''), headers });
  };
  function create(input: OAuthCreateInput): Promise<OAuthEntry>;
  function create(input: CredentialCreateInput): Promise<CredentialEntry>;
  function create(input: CredentialCreateInput | OAuthCreateInput): Promise<CredentialEntry> {
    const credential = client().credential;
    if (input.value.type !== 'oauth') return credential.create({ ...input, value: input.value });
    const { metadata, ...value } = input.value;
    return credential.create({ ...input, value: metadata === undefined ? value : { ...value, metadata } });
  }
  return {
    list: () => client().credential.list(),
    create,
    remove: (credentialID: string) => client().credential.remove({ credentialID }),
    listEnvironmentKeys: async () => {
      const environment = getLaunchEnvironment();
      if (!environment) return {};
      const { data } = await client(getDefaultDirectory()).integration.list();
      return projectEnvironmentKeys(data, environment);
    },
    readUsageLimits: async () => (await client(getDefaultDirectory()).experimental.usage.limits()).data,
  };
};

const metadataString = z.string();

type ProjectableCredential = CredentialValue & Pick<Partial<CredentialOAuth>, 'access' | 'refresh' | 'expires'>;
const projectCredentialValue = (value: ProjectableCredential): LegacyAuthEntry => {
  if (value.type === 'key') {
    return value.metadata ? { type: 'api', key: value.key, metadata: value.metadata } : { type: 'api', key: value.key };
  }
  const entry: Extract<LegacyAuthEntry, { type: 'oauth' }> = { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
  const accountId = metadataString.safeParse(value.metadata?.accountID).data;
  const enterpriseUrl = metadataString.safeParse(value.metadata?.enterpriseUrl).data;
  const server = metadataString.safeParse(value.metadata?.server).data;
  const orgID = metadataString.safeParse(value.metadata?.orgID).data;
  if (accountId !== undefined) entry.accountId = accountId;
  if (enterpriseUrl !== undefined) entry.enterpriseUrl = enterpriseUrl;
  if (server !== undefined) entry.server = server;
  if (orgID !== undefined) entry.orgID = orgID;
  return entry;
};

export const projectCredentialEntries = (entries: CredentialEntry[]) => {
  const result: LegacyAuthFile = {};
  for (const entry of entries) {
    if (entry.active) result[entry.integrationID] = projectCredentialValue(entry.value);
  }
  return result;
};

const readStored = async (current: CredentialSource) => projectCredentialEntries(await current.list());

const readWithEnvironment = async (current: CredentialSource) => {
  const noEnvironment: Record<string, string> = {};
  const [stored, environmentKeys] = await Promise.all([
    readStored(current),
    current.listEnvironmentKeys ? current.listEnvironmentKeys() : noEnvironment,
  ]);
  const result: LegacyAuthFile = {};
  for (const [integrationID, key] of Object.entries(environmentKeys)) result[integrationID] = { type: 'api', key };
  return { ...result, ...stored };
};

const coalesce = <Result>() => {
  let pending: Promise<Result> | null = null;
  return (read: (current: CredentialSource) => Promise<Result>) => {
    if (!pending) {
      const current = source;
      pending = (current ? read(current) : Promise.reject(new Error('OpenCode is not connected yet')))
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
};

const sharedRead = coalesce<LegacyAuthFile>();
const sharedStoredRead = coalesce<LegacyAuthFile>();
const sharedLoginRead = coalesce<Record<string, StoredLogin>>();

export interface StoredLogin {
  methodID: string;
  access: string;
  expires: number;
  metadata: Metadata;
}
export interface ExchangedLogin {
  access: string;
  refresh: string;
  expires: number;
  metadata?: Metadata;
}

const projectLogin = ({ methodID, access, expires, metadata }: CredentialOAuth): StoredLogin => ({ methodID, access, expires, metadata: metadata ?? {} });
const readLogins = async (current: CredentialSource) => {
  const result: Record<string, StoredLogin> = {};
  for (const entry of await current.list()) {
    if (entry.active && entry.value.type === 'oauth') result[entry.integrationID] = projectLogin(entry.value);
  }
  return result;
};
const selectedLogin = (entries: CredentialEntry[], integrationID: string) => entries.find(
  (entry): entry is OAuthEntry => entry.integrationID === integrationID && entry.active && entry.value.type === 'oauth',
) ?? null;

export function readOpenCodeCredentials() {
  return sharedRead(readWithEnvironment);
}

export async function readOpenCodeUsageLimits() {
  if (!source?.readUsageLimits) throw new Error('OpenCode is not connected yet');
  return source.readUsageLimits();
}

export async function getProviderAuth(providerId: string) {
  const credentials = await sharedStoredRead(readStored);
  return credentials[providerId] || null;
}

export async function getStoredLogin(integrationID: string) {
  const logins = await sharedLoginRead(readLogins);
  return logins[integrationID] || null;
}

export async function renewStoredLogin(
  integrationID: string,
  exchange: (login: { methodID: string; refresh: string; metadata: Metadata }) => Promise<ExchangedLogin>,
) {
  const current = source;
  if (!current) throw new Error('OpenCode is not connected yet');
  if (!current.create || !current.remove) throw new Error('This OpenCode connection cannot write a login');
  const before = selectedLogin(await current.list(), integrationID);
  if (!before) return null;
  const { methodID, refresh, metadata } = before.value;
  const exchanged = await exchange({ methodID, refresh, metadata: metadata ?? {} });
  const meanwhile = selectedLogin(await current.list(), integrationID);
  if (!meanwhile) return null;
  if (meanwhile.id !== before.id || meanwhile.value.expires !== before.value.expires || meanwhile.value.access !== before.value.access) return projectLogin(meanwhile.value);
  const created = await current.create({
    integrationID,
    label: before.label,
    value: { type: 'oauth', methodID, access: exchanged.access, refresh: exchanged.refresh, expires: exchanged.expires, metadata: exchanged.metadata },
    activate: true,
  });
  await current.remove(before.id);
  return projectLogin(created.value);
}
