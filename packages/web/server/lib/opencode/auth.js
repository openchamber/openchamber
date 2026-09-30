/**
 * READ-ONLY view of OpenCode's provider credentials, shared by the web server
 * and the VS Code extension host.
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
 * providers is the provider id. Nothing here writes.
 */

import { OpenCode } from '@opencode/client';
import { z } from 'zod';

// Wired once per runtime: `server/index.js` on the web server, the extension
// entry point in VS Code. Until then every read throws.
let source = null;

/** Wires the reader to a credential source (`{ list }`). Pass `null` to detach. */
export function configureOpenCodeCredentials(next) {
  source = next ?? null;
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
 */
export const openCodeCredentialSource = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, getLaunchEnvironment = () => null }) => {
  const client = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
    headers: { ...getOpenCodeAuthHeaders() },
  });
  return {
    list: () => client().credential.list(),
    listEnvironmentKeys: async () => {
      const environment = getLaunchEnvironment();
      if (!environment) return {};
      const { data } = await client().integration.list();
      return projectEnvironmentKeys(data, environment);
    },
  };
};

const metadataString = z.string();

/** One stored credential value → legacy `auth.json` entry. */
const projectCredentialValue = (value) => {
  if (value.type === 'key') {
    return value.metadata ? { type: 'api', key: value.key, metadata: value.metadata } : { type: 'api', key: value.key };
  }
  const entry = { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
  const accountId = metadataString.safeParse(value.metadata?.accountID).data;
  const enterpriseUrl = metadataString.safeParse(value.metadata?.enterpriseUrl).data;
  if (accountId !== undefined) entry.accountId = accountId;
  if (enterpriseUrl !== undefined) entry.enterpriseUrl = enterpriseUrl;
  return entry;
};

/** Each integration's selected credential; OpenCode marks exactly one `active` per integration. */
export const projectCredentialEntries = (entries) => {
  const result = {};
  for (const entry of entries) {
    if (entry.active) result[entry.integrationID] = projectCredentialValue(entry.value);
  }
  return result;
};

const readStored = async (current) => projectCredentialEntries(await current.list());

const readWithEnvironment = async (current) => {
  const [stored, environmentKeys] = await Promise.all([
    readStored(current),
    current.listEnvironmentKeys ? current.listEnvironmentKeys() : {},
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

/**
 * The keys the running OpenCode uses, keyed by provider id: stored
 * credentials, plus variable keys when OpenChamber launched OpenCode.
 * Throws when OpenCode cannot be asked.
 */
export function readOpenCodeCredentials() {
  return sharedRead(readWithEnvironment);
}

/**
 * The credential stored for one provider, or null. Variables do not count:
 * callers ask whether a login exists in OpenCode's own store.
 */
export async function getProviderAuth(providerId) {
  const credentials = await sharedStoredRead(readStored);
  return credentials[providerId] || null;
}
