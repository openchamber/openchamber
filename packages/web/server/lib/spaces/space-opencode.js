
import { z } from 'zod';

import { SpaceError } from './errors.js';
import { addressThroughWindow } from './host-catalog.js';
import { tail } from './exec-http.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, LEGACY_SPACE_OPENCODE_CONFIG_PATH, spaceOpenCodeConfigDirectory, spaceOpenCodeConfigPath, spaceWindowUrl } from './layout.js';
import { providerIdSchema } from './space-records.js';

export const WINDOW_PLACEHOLDER_KEY = 'space-window';

const writeConfigScriptOf = (spaceId) => {
  const file = spaceOpenCodeConfigPath(spaceId);
  return [IMAGE_ONLY_PATH, `mkdir -p ${spaceOpenCodeConfigDirectory(spaceId)}`, `&& cat > ${file}.new && mv ${file}.new ${file}`, `&& rm -f ${LEGACY_SPACE_OPENCODE_CONFIG_PATH}`].join(' ');
};

export function buildProviderConfig(grants, customProviders = new Map(), catalogProviders = new Map()) {
  const provider = {};
  const providers = {};
  for (const grant of grants) {
    const catalog = grant.kind === 'model' ? catalogProviders.get(grant.provider) : undefined;
    if (catalog) providers[grant.provider] = catalogEntryOf(grant, catalog);
    else if (grant.kind === 'model') provider[grant.provider] = { options: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY } };
    if (grant.kind === 'login') {
      const options = loginMethodOf(grant.provider, grant.method)?.options(spaceWindowUrl(grant.id));
      if (options) provider[grant.provider] = { options };
    }
    if (grant.kind === 'custom') {
      const definition = customProviders.get(grant.provider);
      if (definition) providers[grant.provider] = { name: definition.name, package: definition.package, settings: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY }, models: definition.models };
    }
  }
  const config = { $schema: 'https://opencode.ai/config.json', provider };
  if (Object.keys(providers).length > 0) config.providers = providers;
  return config;
}

const catalogEntryOf = (grant, catalog) => {
  const window = spaceWindowUrl(grant.id);
  const settings = { apiKey: WINDOW_PLACEHOLDER_KEY };
  const base = catalog.baseURL === null ? null : addressThroughWindow(catalog.baseURL, grant.upstream, window);
  if (base) settings.baseURL = base;
  const models = {};
  for (const model of catalog.models) {
    const address = model.baseURL === null ? null : addressThroughWindow(model.baseURL, grant.upstream, window);
    if (address) models[model.id] = { settings: { baseURL: address } };
  }
  return Object.keys(models).length > 0 ? { settings, models } : { settings };
};

export const START_CONFIG_VARIABLE = 'OPENCODE_CONFIG_CONTENT';

const startConfigSchema = z.object({
  providers: z.record(providerIdSchema, z.object({
    settings: z.object({ baseURL: z.string(), apiKey: z.literal(WINDOW_PLACEHOLDER_KEY) }).strict(),
  }).strict()),
}).strict();

export function buildStartConfig(customProviderIds) {
  if (customProviderIds.length === 0) return null;
  const providers = {};
  for (const id of customProviderIds) providers[id] = { settings: { baseURL: spaceWindowUrl(id), apiKey: WINDOW_PLACEHOLDER_KEY } };
  return JSON.stringify({ providers });
}

export function isStartConfig(text) {
  let parsed;
  try {
    parsed = startConfigSchema.safeParse(JSON.parse(text));
  } catch {
    return false;
  }
  return parsed.success && Object.entries(parsed.data.providers).every(([id, entry]) => entry.settings.baseURL === spaceWindowUrl(id));
}

const CODEX_API = 'https://chatgpt.com/backend-api/codex';
const COPILOT_API = 'https://api.githubcopilot.com';
const CHATGPT_METADATA_KEYS = ['accountID', 'clientID', 'scopes'];
const chatgptRowMetadataOf = (login) => {
  const metadata = {};
  for (const key of CHATGPT_METADATA_KEYS) if (login.metadata[key] !== undefined) metadata[key] = login.metadata[key];
  return metadata;
};
const chatgptOptionsOf = (windowUrl) => ({ baseURL: windowUrl, transport: 'http' });
const CHATGPT_METHOD = { upstream: () => 'https://api.openai.com/v1', rowMetadata: chatgptRowMetadataOf, options: chatgptOptionsOf, ends: true };
const CODEX_METHOD = { upstream: () => CODEX_API, rowMetadata: chatgptRowMetadataOf, options: chatgptOptionsOf, ends: true };
const copilotMetadataSchema = z.object({ apiEndpoint: z.string().min(1).optional(), enterpriseUrl: z.string().min(1).optional() });
const copilotUpstreamOf = (login) => {
  const metadata = copilotMetadataSchema.safeParse(login.metadata);
  if (!metadata.success) return COPILOT_API;
  const { apiEndpoint, enterpriseUrl } = metadata.data;
  if (apiEndpoint) return apiEndpoint;
  if (enterpriseUrl) return `https://copilot-api.${enterpriseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return COPILOT_API;
};
const COPILOT_METHOD = {
  upstream: copilotUpstreamOf,
  rowMetadata: (login, windowUrl) => ({ apiEndpoint: windowUrl }),
  options: () => null,
  ends: false,
};

const LOGIN_METHODS = new Map([
  ['openai/chatgpt-token-sharing', CHATGPT_METHOD],
  ['openai/chatgpt-browser', CODEX_METHOD],
  ['openai/chatgpt-headless', CODEX_METHOD],
  ['github-copilot/device', COPILOT_METHOD],
]);
const loginMethodOf = (provider, methodID) => LOGIN_METHODS.get(`${provider}/${methodID}`) ?? null;
export const LOGIN_PROVIDERS = Array.from(new Set(Array.from(LOGIN_METHODS.keys(), (key) => key.split('/')[0])));
export const spaceLoginCredentialId = (provider) => `cred_openchamber_space_${provider}`;
const LEGACY_LOGIN_CREDENTIAL_ID = 'cred_openchamber_space';
const NEVER_EXPIRES = Date.UTC(2100, 0, 1);

export function loginGrantOf(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  return method ? { upstream: method.upstream(login), header: 'authorization', secret: login.access } : null;
}

export function loginEndOf(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  return method && !method.ends ? null : login.expires;
}

export function loginEnded(provider, login, nowMs) {
  const end = loginEndOf(provider, login);
  return end !== null && end <= nowMs;
}

export function buildLoginRow(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  if (!method) throw new SpaceError('login_not_supported', `The ${provider} login was made in a way a space cannot be given (${login.methodID}).`);
  const metadata = method.rowMetadata(login, spaceWindowUrl(provider));
  const value = { type: 'oauth', methodID: login.methodID, access: WINDOW_PLACEHOLDER_KEY, refresh: WINDOW_PLACEHOLDER_KEY, expires: NEVER_EXPIRES };
  if (Object.keys(metadata).length > 0) value.metadata = metadata;
  return { id: spaceLoginCredentialId(provider), integrationID: provider, label: 'OpenChamber space', value };
}

const CHAT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
const CHAT_EXPORT_TIMEOUT_MS = 5 * 60_000;
const ROW_TIMEOUT_MS = 30_000;

export const chatIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/);

const instantSchema = z.number().int().nonnegative();
const countSchema = z.number().nonnegative();

const exportedInfoSchema = z.object({
  id: chatIdSchema,
  parentID: chatIdSchema.optional(),
  projectID: z.string().min(1).max(256),
  cost: countSchema,
  tokens: z.object({
    input: countSchema,
    output: countSchema,
    reasoning: countSchema,
    cache: z.object({ read: countSchema, write: countSchema }),
  }),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  time: z.object({ created: instantSchema, updated: instantSchema, idle: instantSchema.optional() }),
  title: z.string().max(4096).optional(),
});

const exportedChatSchema = z.object({
  data: z.object({
    info: exportedInfoSchema,
    messages: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()),
  }),
});

const readCapped = (response, cap, timeoutMs) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const fail = (error) => {
    clearTimeout(timer);
    response.destroy();
    reject(error);
  };
  const timer = setTimeout(() => fail(new SpaceError('chat_export_timed_out', `The chat did not come whole in ${timeoutMs} ms`)), timeoutMs);
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > cap) {
      fail(new SpaceError('chat_too_large', `The chat is larger than ${cap} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    clearTimeout(timer);
    resolve(Buffer.concat(chunks));
  });
  response.on('error', (error) => fail(error));
});

const ARCHIVED_CHAT_PERMISSIONS = Object.freeze([Object.freeze({ action: '*', resource: '*', effect: 'deny' })]);

export function archivedChatOf({ info, messages }, { directory, archivedAt, keepParent }) {
  const time = { created: info.time.created, updated: info.time.updated, archived: archivedAt };
  if (info.time.idle !== undefined) time.idle = info.time.idle;
  const record = {
    id: info.id,
    projectID: info.projectID,
    cost: info.cost,
    tokens: info.tokens,
    time,
    location: { directory },
    permissions: ARCHIVED_CHAT_PERMISSIONS,
  };
  if (info.parentID && keepParent) record.parentID = info.parentID;
  if (info.outcome) record.outcome = info.outcome;
  if (info.title !== undefined) record.title = info.title;
  return { info: record, messages, location: { directory } };
}

export function createSpaceOpenCode({ exec, requestInside, chatMaxBytes = CHAT_EXPORT_MAX_BYTES, chatTimeoutMs = CHAT_EXPORT_TIMEOUT_MS }) {
  const writeProviderConfig = async (spaceId, grants, customProviders = new Map(), catalogProviders = new Map()) => {
    const text = `${JSON.stringify(buildProviderConfig(grants, customProviders, catalogProviders), null, 2)}\n`;
    const result = await exec(spaceId, [IMAGE_SH, '-c', writeConfigScriptOf(spaceId)], { stdin: text });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not write the provider configuration inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  const exportChat = async (spaceId, chatId) => {
    const id = chatIdSchema.parse(chatId);
    const response = await requestInside(spaceId, {
      path: `/api/experimental/session/${id}/export`,
      headers: { accept: 'application/json' },
      timeoutMs: chatTimeoutMs,
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new SpaceError('chat_export_failed', `The space answered ${response.statusCode} for chat ${id}`);
    }
    const body = await readCapped(response, chatMaxBytes, chatTimeoutMs);
    let parsed;
    try {
      parsed = exportedChatSchema.safeParse(JSON.parse(body.toString('utf8')));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success || parsed.data.data.info.id !== id) throw new SpaceError('chat_export_failed', `The space did not give chat ${id} whole`);
    return parsed.data.data;
  };

  const askInside = async (spaceId, request) => {
    const headers = { accept: 'application/json' };
    if (request.body) headers['content-type'] = 'application/json';
    const response = await requestInside(spaceId, { ...request, headers, timeoutMs: ROW_TIMEOUT_MS });
    response.resume();
    await new Promise((resolve) => { response.on('end', resolve); response.on('error', resolve); response.on('close', resolve); });
    return response.statusCode;
  };

  const removeLogin = async (spaceId, provider) => {
    for (const id of [spaceLoginCredentialId(provider), LEGACY_LOGIN_CREDENTIAL_ID]) {
      const status = await askInside(spaceId, { method: 'DELETE', path: `/api/credential/${id}` });
      if (status !== 204 && status !== 200 && status !== 404) throw new SpaceError('space_setup_failed', `Could not remove the ${provider} login row inside the space: OpenCode answered ${status}`);
    }
  };

  const writeLogin = async (spaceId, provider, login) => {
    await removeLogin(spaceId, provider);
    const status = await askInside(spaceId, { method: 'POST', path: '/api/credential', body: JSON.stringify(buildLoginRow(provider, login)) });
    if (status !== 200) throw new SpaceError('space_setup_failed', `Could not write the login row inside the space: OpenCode answered ${status}`);
  };

  return { writeProviderConfig, writeLogin, removeLogin, exportChat };
}
