
import { OpenCode } from '@opencode/client';
import { z } from 'zod';

let source = null;

export function configureOpenCodeCredentials(next) {
  source = next ?? null;
}

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

const projectCredentialValue = (value) => {
  if (value.type === 'key') {
    return value.metadata ? { type: 'api', key: value.key, metadata: value.metadata } : { type: 'api', key: value.key };
  }
  const entry = { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
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
const sharedLoginRead = coalesce();

const projectLogin = ({ methodID, access, expires, metadata }) => ({ methodID, access, expires, metadata: metadata ?? {} });
const readLogins = async (current) => {
  const result = {};
  for (const entry of await current.list()) {
    if (entry.active && entry.value.type === 'oauth') result[entry.integrationID] = projectLogin(entry.value);
  }
  return result;
};
const selectedLogin = (entries, integrationID) => entries.find((entry) => entry.integrationID === integrationID && entry.active && entry.value.type === 'oauth') ?? null;

export function readOpenCodeCredentials() {
  return sharedRead(readWithEnvironment);
}

export async function readOpenCodeUsageLimits() {
  if (!source?.readUsageLimits) throw new Error('OpenCode is not connected yet');
  return source.readUsageLimits();
}

export async function getProviderAuth(providerId) {
  const credentials = await sharedStoredRead(readStored);
  return credentials[providerId] || null;
}

export async function getStoredLogin(integrationID) {
  const logins = await sharedLoginRead(readLogins);
  return logins[integrationID] || null;
}

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
