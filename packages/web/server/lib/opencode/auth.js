/**
 * OpenCode's provider credentials as the running OpenCode holds them, shared
 * by the web server and the VS Code extension host. Reads, and one write.
 *
 * OpenCode 2.x owns every credential. Since 2.0.20 it hands them back over
 * `GET /api/credential`, secrets included, so the quota providers, voice keys
 * and routing read what the running OpenCode actually uses. Each call asks
 * OpenCode; concurrent callers share one request. A failed read throws rather
 * than answering `{}`: "OpenCode is unreachable" must not look like "the user
 * has no keys".
 *
 * A key OpenCode picks up from an environment variable (`ZAI_API_KEY`, ...)
 * is never stored, and that route does not list it. `GET /api/integration`
 * names the variable a connection came from, but not its value. When
 * OpenChamber launched OpenCode itself it knows the environment it passed, so
 * the source reads the value from there; an external OpenCode runs with an
 * environment of its own, and its variable keys stay unknown. A stored
 * credential wins over a variable, which is the order OpenCode itself uses.
 *
 * The answer keeps the legacy `auth.json` entry shape the consumers were
 * written against: `{ type: 'api', key }` / `{ type: 'oauth', access, refresh,
 * expires, accountId?, enterpriseUrl? }`, keyed by integration id, which for
 * providers is the provider id. `listStoredCredentials` answers the same
 * values as a row list (id, label, active flag, integration id) for the
 * consumers, quota today, that read every credential of an integration
 * instead of only the selected one.
 *
 * One write exists, `renewStoredLogin`: an isolated space's gatekeeper holds
 * the host's short OpenAI token, and the host keeps it fresh itself, because
 * OpenCode refreshes a login only when the user sends it a prompt. The new
 * login goes in through `POST /api/credential` and the old row is removed
 * after it, which is how OpenCode takes a login from outside.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';
import { OpenCodeUpstreamAuthError, isOpenCodeUpstreamAuthRejection } from './credential-auth-error.js';
import { isLoopbackUrl } from '../security/bind-host.js';

// Wired once per runtime: `server/index.js` on the web server, the extension
// entry point in VS Code. Until then every read throws.
let source = null;

/** Wires the reader to a credential source (`{ list }`). Pass `null` to detach. */
export function configureOpenCodeCredentials(next) {
  source = next ?? null;
}

const isLoopbackOpenCodeUrl = (raw) => isLoopbackUrl(raw);

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

/**
 * The value of each variable OpenCode reports as a connection, keyed by
 * integration id, taken from the environment OpenCode was launched with.
 */
export const projectEnvironmentKeys = (integrations, environment) => {
  const result = {};
  for (const integration of integrations) {
    for (const connection of integration.connections) {
      if (connection.type !== 'env' || integration.id in result) continue;
      const key = (environment[connection.name] ?? '').trim();
      if (key) result[integration.id] = key;
    }
  }
  return result;
};

/**
 * The running OpenCode as a credential source. The URL and auth headers are
 * read on every call because the port and the server password both move
 * across an OpenCode restart. `getLaunchEnvironment` answers the environment
 * a managed OpenCode was started with, or null for an external one.
 *
 * Credentials are global, but integrations are read through a location:
 * without a directory OpenCode would start its own working directory, MCP
 * servers included, so that read is scoped to `getDefaultDirectory()`.
 */
export const openCodeCredentialSource = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getLaunchEnvironment = () => null,
  getDefaultDirectory = () => null,
}) => {
  const client = (directory = null) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''), headers });
  };
  return {
    list: () => client().credential.list(),
    create: (input) => client().credential.create(input),
    remove: (credentialID) => client().credential.remove({ credentialID }),
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
  };
};

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set (absolute, or
 * relative to the data directory), else `opencode.db` in the data
 * directory, which follows `XDG_DATA_HOME` as OpenCode does.
 */
const resolveOpenCodeDbPath = (env) => {
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
const loadLocalSqliteOpener = async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (dbPath) => new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // fall through to bun:sqlite
  }
  try {
    const { Database } = await import('bun:sqlite');
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
const readLocalCredentialEntries = (db, dbPath) => {
  const rows = db
    .prepare('select id, integration_id, label, value from credential order by active asc, time_created asc, id asc')
    .all();
  const entries = [];
  let skipped = 0;
  for (const row of rows) {
    let value = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    if (!row.integration_id || !value || (value.type !== 'key' && value.type !== 'oauth')) {
      skipped += 1;
      continue;
    }
    entries.push({ id: row.id, integrationID: row.integration_id, label: row.label, value });
  }
  if (entries.length === 0 && rows.length > 0) {
    throw new Error(`OpenCode credential store at ${dbPath} holds ${rows.length} rows but none could be read`);
  }
  if (skipped > 0) {
    console.warn(`OpenCode credential store at ${dbPath}: skipped ${skipped} unreadable credential rows.`);
  }
  const selectedIndex = new Map();
  entries.forEach((entry, index) => selectedIndex.set(entry.integrationID, index));
  return entries.map((entry, index) => ({ ...entry, active: selectedIndex.get(entry.integrationID) === index }));
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
export const openCodeLocalCredentialSource = ({ env = process.env, dbPath, openDatabase } = {}) => ({
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

/** One stored credential value → legacy `auth.json` entry. */
const projectCredentialValue = (value) => {
  if (value.type === 'key') {
    return value.metadata ? { type: 'api', key: value.key, metadata: value.metadata } : { type: 'api', key: value.key };
  }
  const entry = { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
  const accountId = metadataString.safeParse(value.metadata?.accountID).data;
  const enterpriseUrl = metadataString.safeParse(value.metadata?.enterpriseUrl).data;
  // OpenCode Console signs in through the `opencode` integration and records the
  // Console server and selected organization on the credential. Only these two
  // travel on: the rest of the metadata (email, account name) is not needed by
  // any consumer, and account identifiers stay out of the read path.
  const server = metadataString.safeParse(value.metadata?.server).data;
  const orgID = metadataString.safeParse(value.metadata?.orgID).data;
  if (accountId !== undefined) entry.accountId = accountId;
  if (enterpriseUrl !== undefined) entry.enterpriseUrl = enterpriseUrl;
  if (server !== undefined) entry.server = server;
  if (orgID !== undefined) entry.orgID = orgID;
  return entry;
};

/** Each integration's selected credential; OpenCode marks exactly one `active` per integration. */
export const projectCredentialEntries = (entries) => {
  const result = {};
  for (const entry of entries) {
    if (!entry.active) continue;
    // defineProperty, not plain assignment: assigning a '__proto__'
    // integration id would set the projection's prototype instead of
    // creating an enumerable own entry for that credential.
    Object.defineProperty(result, entry.integrationID, {
      value: projectCredentialValue(entry.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
};

/** Every stored credential as a row: store id, label, active flag, and the projected legacy entry. */
export const projectCredentialRows = (entries) => entries.map((entry) => ({
  id: entry.id,
  integrationID: entry.integrationID,
  label: asNonEmptyString(entry.label),
  active: Boolean(entry.active),
  value: projectCredentialValue(entry.value),
}));

const UPSTREAM_AUTH_REJECTION_STATUS = 401;
const UPSTREAM_AUTH_REJECTION_BODY = 'authentication required';

/**
 * The OpenCode client fails a rejected credential read with a 401 whose body
 * is the bare string `Authentication required`.
 */
const isCredentialSourceRejection = (error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status;
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
const markCredentialSourceRejection = (error) => {
  if (isOpenCodeUpstreamAuthRejection(error) || !isCredentialSourceRejection(error)) return error;
  return new OpenCodeUpstreamAuthError(
    error instanceof Error ? error.message : undefined,
    { cause: error },
  );
};

const listCredentialEntries = async (current) => {
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
const readEnvironmentKeys = async (current) => {
  try {
    return current.listEnvironmentKeys ? await current.listEnvironmentKeys() : {};
  } catch (error) {
    throw markCredentialSourceRejection(error);
  }
};

const readStored = async (current) => projectCredentialEntries(await listCredentialEntries(current));

const readWithEnvironment = async (current) => {
  const [stored, environmentKeys] = await Promise.all([
    readStored(current),
    readEnvironmentKeys(current),
  ]);
  const result = {};
  for (const [integrationID, key] of Object.entries(environmentKeys)) result[integrationID] = { type: 'api', key };
  return { ...result, ...stored };
};

const coalesce = () => {
  let pending = null;
  return (read) => {
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

const sharedRead = coalesce();
const sharedStoredRead = coalesce();
const sharedLoginRead = coalesce();
const sharedCredentialRowsRead = coalesce();

/**
 * Each integration's selected browser login, as OpenCode stores it: the method, the short access
 * token, when it ends, and the login's metadata. The refresh token stays with OpenCode.
 */
const projectLogin = ({ methodID, access, expires, metadata }) => ({ methodID, access, expires, metadata: metadata ?? {} });
const readLogins = async (current) => {
  const result = {};
  for (const entry of await listCredentialEntries(current)) {
    if (entry.active && entry.value.type === 'oauth') result[entry.integrationID] = projectLogin(entry.value);
  }
  return result;
};
/** The stored row OpenCode has selected for an integration, when it is a browser login. */
const selectedLogin = (entries, integrationID) => entries.find((entry) => entry.integrationID === integrationID && entry.active && entry.value.type === 'oauth') ?? null;

/**
 * The keys the running OpenCode uses, keyed by provider id: stored
 * credentials, plus variable keys when OpenChamber launched OpenCode.
 * Throws when OpenCode cannot be asked.
 */
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

/**
 * The credential stored for one provider, or null. Variables do not count:
 * callers ask whether a login exists in OpenCode's own store.
 */
export async function getProviderAuth(providerId) {
  const credentials = await sharedStoredRead(readStored);
  // Own-property guard: a plain lookup resolves prototype-name ids
  // ('constructor', 'toString', '__proto__', ...) to inherited
  // Object.prototype members, fabricating stored auth.
  return Object.hasOwn(credentials, providerId) ? credentials[providerId] || null : null;
}

const readAllCredentialRows = async (current) => projectCredentialRows(await listCredentialEntries(current));

/**
 * Every credential row OpenCode stores, in store order, or only the rows of
 * one integration when `integrationID` is given. Unlike the projected read,
 * no row is dropped for being inactive: callers enumerate accounts.
 * Environment-variable keys are not store rows and never appear here.
 * Throws when OpenCode cannot be asked.
 */
export async function listStoredCredentials(integrationID) {
  const rows = await sharedCredentialRowsRead(readAllCredentialRows);
  return integrationID ? rows.filter((row) => row.integrationID === integrationID) : rows;
}

/**
 * The browser login OpenCode has selected for one integration, with the method
 * it was made by (`chatgpt-token-sharing`, `chatgpt-browser`, ...), or null
 * when the selected credential is a key or there is none. An isolated space
 * is given such a login through its gatekeeper; the space never sees it.
 */
export async function getStoredLogin(integrationID) {
  const logins = await sharedLoginRead(readLogins);
  return logins[integrationID] || null;
}

/**
 * Replaces the browser login OpenCode has selected for an integration with the one `exchange`
 * makes from it: `exchange({ methodID, refresh, metadata })` asks the issuer for new tokens and
 * answers `{ access, refresh, expires, metadata }`. The refresh token passes through that call
 * and is kept nowhere. The new row is created first, active, and the old one removed after it,
 * so no request of the host's finds the integration without a login in between. OpenCode
 * refreshes the same login itself when the user prompts it within five minutes of its end, so
 * the row is read again before the write: one that changed in the meantime wins, and the
 * exchanged tokens are dropped. Answers the login OpenCode holds afterwards, in the shape of
 * `getStoredLogin`, or null when it holds none. Throws when OpenCode cannot be asked, when the
 * connection cannot write, or when the exchange or the write fails.
 */
export async function renewStoredLogin(integrationID, exchange) {
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
