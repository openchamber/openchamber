import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { OpenCode } from '@opencode/client';
import type { CredentialCreateInput, CredentialEntry, CredentialOAuth, CredentialValue, IntegrationInfo, JsonValue, UsageLimitsInfo } from '@opencode/client';
import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';
import { OpenCodeUpstreamAuthError, isOpenCodeUpstreamAuthRejection } from './credential-auth-error.js';
import { isLoopbackUrl } from '../security/bind-host.js';

export type LegacyAuthEntry =
  | { type: 'api'; key: string; label?: string; metadata?: { [key: string]: JsonValue } }
  | { type: 'oauth'; access: string | undefined; refresh: string | undefined; expires: number | undefined; label?: string; methodID?: string; accountId?: string; enterpriseUrl?: string; server?: string; orgID?: string };
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
  // True when the source reads this machine's credential store, so a
  // direct read of that store answers for the same credentials.
  usesLocalStore?: () => boolean;
  getLaunchEnvironment?: () => NodeJS.ProcessEnv | null;
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

const isLoopbackOpenCodeUrl = (raw: string) => isLoopbackUrl(raw);

/**
 * Whether the wired credential source is known to read the credential
 * store on this machine (see `openCodeCredentialSource`). A source that
 * does not say — a test fixture, the quota CLI's combined source — is
 * treated as not known, so a direct local-store read is never enabled
 * by default.
 */
export function credentialSourceUsesLocalStore() {
  try {
    return Boolean(source?.usesLocalStore?.());
  } catch {
    return false;
  }
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
    usesLocalStore: () => {
      // A managed OpenCode is one OpenChamber launched on this machine,
      // and a loopback connection can only reach an OpenCode on this
      // machine: both are known to read this machine's credential store.
      // Any other connection (OPENCODE_HOST naming another host) is not,
      // and a reader must not substitute this machine's store for it.
      if (getLaunchEnvironment()) return true;
      try {
        return isLoopbackOpenCodeUrl(buildOpenCodeUrl('', ''));
      } catch {
        return false;
      }
    },
    getLaunchEnvironment: () => getLaunchEnvironment(),
    listEnvironmentKeys: async () => {
      const environment = getLaunchEnvironment();
      if (!environment) return {};
      const { data } = await client(getDefaultDirectory()).integration.list();
      return projectEnvironmentKeys(data, environment);
    },
    readUsageLimits: async () => (await client(getDefaultDirectory()).experimental.usage.limits()).data,
  };
};

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set (absolute, or
 * relative to the data directory), else `opencode.db` in the data
 * directory, which follows `XDG_DATA_HOME` as OpenCode does.
 */
const resolveOpenCodeDbPath = (env: NodeJS.ProcessEnv) => {
  const home = asNonEmptyString(env.HOME) ?? os.homedir();
  const dataHome = asNonEmptyString(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share');
  const dataDir = path.join(dataHome, 'opencode');
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, 'opencode.db');
};

// The driver is imported lazily, the way the routing telemetry reader does
// it: a static import of `node:sqlite` would keep a runtime that lacks it
// from loading this module at all, and only the local source needs SQLite.
interface LocalCredentialDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
type LocalDatabaseOpener = (dbPath: string) => LocalCredentialDatabase;

const loadLocalSqliteOpener = async (): Promise<LocalDatabaseOpener | null> => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (dbPath) => new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // fall through to bun:sqlite
  }
  try {
    const { Database }: { Database: new (dbPath: string, options?: { readonly?: boolean }) => LocalCredentialDatabase } = createRequire(import.meta.url)('bun:sqlite');
    return (dbPath) => new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
};

/**
 * The rows of OpenCode's `credential` table in the order the server lists
 * them: selection sorts each integration's chosen row last (the `active`
 * flag first, then creation order, then id), and the listing marks that
 * last row active. Rows the server would skip (no integration, a value
 * that is not a credential) are skipped here too, with a warning; a table
 * that holds rows but none readable is a failure, never an empty store.
 */
const localCredentialRowSchema = z.object({
  id: z.string(),
  integration_id: z.string().nullable(),
  label: z.string().nullable(),
  value: z.string(),
});
// OpenCode writes each row's value as its own CredentialValue JSON; a value
// that is not a key or OAuth credential is skipped, as the server skips it.
const localCredentialValueSchema = z.custom<CredentialValue>((value) => isPlainCredential(value));

const isPlainCredential = (value: unknown) => value !== null && typeof value === 'object'
  && 'type' in value && (value.type === 'key' || value.type === 'oauth');

const parseLocalCredentialValue = (raw: string) => {
  try {
    return localCredentialValueSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
};

const readLocalCredentialEntries = (db: LocalCredentialDatabase, dbPath: string) => {
  const rows = db
    .prepare('select id, integration_id, label, value from credential order by active asc, time_created asc, id asc')
    .all();
  const entries: Omit<CredentialEntry, 'active'>[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const row = localCredentialRowSchema.safeParse(raw).data;
    const value = row ? parseLocalCredentialValue(row.value) : null;
    if (!row?.integration_id || !value) {
      skipped += 1;
      continue;
    }
    entries.push({ id: row.id, integrationID: row.integration_id, label: row.label ?? '', value });
  }
  if (entries.length === 0 && rows.length > 0) {
    throw new Error(`OpenCode credential store at ${dbPath} holds ${rows.length} rows but none could be read`);
  }
  if (skipped > 0) {
    console.warn(`OpenCode credential store at ${dbPath}: skipped ${skipped} unreadable credential rows.`);
  }
  const selectedIndex = new Map<string, number>();
  entries.forEach((entry, index) => selectedIndex.set(entry.integrationID, index));
  return entries.map((entry, index): CredentialEntry => ({ ...entry, active: selectedIndex.get(entry.integrationID) === index }));
};

/**
 * OpenCode's credential store read straight from its database file, with
 * no server in between: the same rows `openCodeCredentialSource` asks the
 * running OpenCode for, in the same shape. This is the quota surfaces'
 * single credential source (code#2490, #2282): the quota CLI wires it
 * directly rather than composing it behind the running-server source,
 * so the CLI and the aggregator gatherer resolve credentials from the
 * one store the same way. Read-only — no create/remove — and it has no
 * launch environment, so variable keys stay unknown exactly as they
 * are for an external OpenCode.
 */
export const openCodeLocalCredentialSource = ({ env = process.env, dbPath, openDatabase }: {
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  openDatabase?: LocalDatabaseOpener;
} = {}) => ({
  // True by construction: this source IS the local store, which is
  // what credentialSourceUsesLocalStore() gates on (the antigravity
  // provider's direct-store read).
  usesLocalStore: () => true,
  list: async () => {
    const resolvedPath = dbPath ?? resolveOpenCodeDbPath(env);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`OpenCode credential store not found at ${resolvedPath}`);
    }
    const open = openDatabase ?? (await loadLocalSqliteOpener());
    if (!open) {
      throw new Error('Reading the local OpenCode credential store needs a runtime with node:sqlite or bun:sqlite');
    }
    const db = open(resolvedPath);
    try {
      return readLocalCredentialEntries(db, resolvedPath);
    } finally {
      db.close();
    }
  },
});

const metadataString = z.string();
const credentialLabel = z.string().trim().min(1);

type ProjectableCredential = CredentialValue & Pick<Partial<CredentialOAuth>, 'access' | 'refresh' | 'expires'>;
const projectCredentialValue = (value: ProjectableCredential): LegacyAuthEntry => {
  if (value.type === 'key') {
    return value.metadata ? { type: 'api', key: value.key, metadata: value.metadata } : { type: 'api', key: value.key };
  }
  const entry: Extract<LegacyAuthEntry, { type: 'oauth' }> = { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
  if (value.type === 'oauth') entry.methodID = value.methodID;
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
    if (!entry.active) continue;
    const projected = projectCredentialValue(entry.value);
    const label = credentialLabel.safeParse(entry.label).data;
    if (label !== undefined) projected.label = label;
    // defineProperty, not plain assignment: assigning a '__proto__'
    // integration id would set the projection's prototype instead of
    // creating an enumerable own entry for that credential.
    Object.defineProperty(result, entry.integrationID, {
      value: projected,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
};

/** Every stored credential as a row: store id, label, active flag, and the projected legacy entry. */
export const projectCredentialRows = (entries: CredentialEntry[]) => entries.map((entry) => ({
  id: entry.id,
  integrationID: entry.integrationID,
  label: asNonEmptyString(entry.label),
  active: Boolean(entry.active),
  value: projectCredentialValue(entry.value),
}));

export type StoredCredentialRow = ReturnType<typeof projectCredentialRows>[number];

const UPSTREAM_AUTH_REJECTION_STATUS = 401;
const UPSTREAM_AUTH_REJECTION_BODY = 'authentication required';

/**
 * The OpenCode client fails a rejected credential read with a 401 whose body
 * is the bare string `Authentication required`.
 */
const statusOf = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  if ('status' in value && value.status !== undefined) return value.status;
  if ('statusCode' in value && value.statusCode !== undefined) return value.statusCode;
  if ('response' in value && value.response !== null && typeof value.response === 'object' && 'status' in value.response) return value.response.status;
  if ('cause' in value) return statusOf(value.cause);
  return undefined;
};

const isCredentialSourceRejection = (error: unknown) => {
  const status = statusOf(error);
  if (Number.isInteger(status)) return status === UPSTREAM_AUTH_REJECTION_STATUS;
  return error instanceof Error
    && String(error.message ?? '').trim().toLowerCase() === UPSTREAM_AUTH_REJECTION_BODY;
};

/**
 * The credential list as the source answers it, with a rejected read marked
 * as coming from the shared credential path (#1129). This is the only place
 * the peer is known to be the running OpenCode, so this is where the
 * failure's origin is recorded; consumers classify by that marker instead of
 * by the error text, which a provider's own API can reuse word for word.
 */
// Mark a credential-path rejection with its provenance, or pass it
// through untouched when it is already marked or is not an auth rejection.
const markCredentialSourceRejection = (error: unknown) => {
  if (isOpenCodeUpstreamAuthRejection(error) || !isCredentialSourceRejection(error)) return error;
  return new OpenCodeUpstreamAuthError(
    error instanceof Error ? error.message : undefined,
    { cause: error },
  );
};

const listCredentialEntries = async (current: CredentialSource) => {
  try {
    return await current.list();
  } catch (error) {
    throw markCredentialSourceRejection(error);
  }
};

// The environment-key read goes to the same server through the same
// credential boundary (integration.list), so its rejections carry the
// same provenance: readWithEnvironment races it against the stored read,
// and an unmarked error here would win the race and lose the marker
// (Codex review, PR #1483).
const readEnvironmentKeys = async (current: CredentialSource): Promise<Record<string, string>> => {
  try {
    return current.listEnvironmentKeys ? await current.listEnvironmentKeys() : {};
  } catch (error) {
    throw markCredentialSourceRejection(error);
  }
};

const readStored = async (current: CredentialSource) => projectCredentialEntries(await listCredentialEntries(current));

const readWithEnvironment = async (current: CredentialSource) => {
  const [stored, environmentKeys] = await Promise.all([
    readStored(current),
    readEnvironmentKeys(current),
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
const sharedCredentialRowsRead = coalesce<ReturnType<typeof projectCredentialRows>>();

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
  for (const entry of await listCredentialEntries(current)) {
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

/**
 * The launch environment of the wired credential source, or null when the
 * source does not say or the connected OpenCode was not launched by
 * OpenChamber. Without it the local store's location cannot be established:
 * OpenChamber's own process.env is not the environment the running OpenCode
 * resolves its database from, and resolving against it can read a different
 * store than the one the connected OpenCode uses.
 */
const wiredLaunchEnvironment = () => {
  try {
    return source?.getLaunchEnvironment?.() ?? null;
  } catch {
    return null;
  }
};

/**
 * The same projected credentials, read straight from OpenCode's credential
 * store on this machine with no server in between. The served projection
 * can withhold a secret a consumer must present itself (the stored-login
 * projection keeps refresh tokens with OpenCode), so a reader that needs
 * the stored value itself falls back to the store — the seam the quota CLI
 * already uses when no server is listening. Throws when the store cannot
 * be read; each caller decides what that means for it.
 */
export async function readLocalOpenCodeCredentials() {
  const launchEnvironment = wiredLaunchEnvironment();
  if (!launchEnvironment) {
    throw new Error(
      "OpenCode local credential store location is unknown: the connected OpenCode was not launched by OpenChamber, so the environment it resolves its database from cannot be established",
    );
  }
  return projectCredentialEntries(await openCodeLocalCredentialSource({ env: launchEnvironment }).list());
}

export async function readOpenCodeUsageLimits() {
  if (!source?.readUsageLimits) throw new Error('OpenCode is not connected yet');
  return source.readUsageLimits();
}

export async function getProviderAuth(providerId: string) {
  const credentials = await sharedStoredRead(readStored);
  // Own-property guard: a plain lookup resolves prototype-name ids
  // ('constructor', 'toString', '__proto__', ...) to inherited
  // Object.prototype members, fabricating stored auth.
  return Object.hasOwn(credentials, providerId) ? credentials[providerId] || null : null;
}

const readAllCredentialRows = async (current: CredentialSource) => projectCredentialRows(await listCredentialEntries(current));

/**
 * Every credential row OpenCode stores, in store order, or only the rows of
 * one integration when `integrationID` is given. Unlike the projected read,
 * no row is dropped for being inactive: callers enumerate accounts.
 * Environment-variable keys are not store rows and never appear here.
 * Throws when OpenCode cannot be asked.
 */
export async function listStoredCredentials(integrationID?: string | null) {
  const rows = await sharedCredentialRowsRead(readAllCredentialRows);
  return integrationID ? rows.filter((row) => row.integrationID === integrationID) : rows;
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
