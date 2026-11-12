// The one place that knows OpenCode's own formats inside a space, so an OpenCode format change is
// a one-file edit (see "Design" in DOCUMENTATION.md). Today: the provider configuration that sends a provider's
// model calls through the gatekeeper's window, since 5e-2 a chat taken out of a space for the
// host's archive, and since stage 7 the login row that puts OpenCode inside into its ChatGPT mode
// while the real token stays in the gatekeeper.
//
// What is written here cooperates and enforces nothing. The agent can change or delete the file
// and the row; the gatekeeper is what keeps the key and the token out of the space and the space
// away from the internet.
//
// A chat taken out is untrusted data, like everything from a space: its record is rebuilt from a
// few checked fields, and the messages go to the host's OpenCode, whose import checks their shape.

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, LEGACY_SPACE_OPENCODE_CONFIG_PATH, spaceOpenCodeConfigDirectory, spaceOpenCodeConfigPath, spaceWindowUrl } from './layout.js';
import { providerIdSchema } from './space-records.js';

// OpenCode takes a key from this option and its auth plugins stay out of the way; the window
// throws it away and puts the real one in its place. It is not a secret and never was one.
export const WINDOW_PLACEHOLDER_KEY = 'space-window';

// Through a temporary name, so OpenCode never reads half a file. The configuration is JSON on
// stdin: nothing of it is an argument; the path holds the space id, which `spaceWorkPath` checks.
// The file the host wrote in the home directory before goes after the new one is in place: the
// host always wrote it whole, so nothing of the agent's is lost that a grant would not have
// overwritten anyway.
const writeConfigScriptOf = (spaceId) => {
  const file = spaceOpenCodeConfigPath(spaceId);
  return [IMAGE_ONLY_PATH, `mkdir -p ${spaceOpenCodeConfigDirectory(spaceId)}`, `&& cat > ${file}.new && mv ${file}.new ${file}`, `&& rm -f ${LEGACY_SPACE_OPENCODE_CONFIG_PATH}`].join(' ');
};

/**
 * OpenCode's configuration for a space with these model grants: each provider, under the
 * id the host's catalog gives it, with its base URL at the window and a placeholder key. The
 * composer offers the host's catalog, and the same provider id inside is what makes that choice
 * work in the space unchanged. Decided with the maintainer on 2026-09-26.
 */
export function buildProviderConfig(grants, customProviders = new Map()) {
  const provider = {};
  const providers = {};
  for (const grant of grants) {
    if (grant.kind === 'model') provider[grant.provider] = { options: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY } };
    // A login takes its token from the row below, so no placeholder key. Copilot's plugin reads
    // its address from the row and not from here, so a Copilot login writes nothing.
    if (grant.kind === 'login') {
      const options = loginMethodOf(grant.provider, grant.method)?.options(spaceWindowUrl(grant.id));
      if (options) provider[grant.provider] = { options };
    }
    // A custom provider is unknown to the catalog inside, so its entry carries what the host's
    // does: the SDK, the name and the models, in OpenCode 2's own spelling, which is what the
    // host's Settings write. The catalog providers above keep the spelling measured on 2.0.25;
    // OpenCode reads both in one file. A definition the host could not read now is left out,
    // and the start that finds it again writes it.
    if (grant.kind === 'custom') {
      const definition = customProviders.get(grant.provider);
      if (definition) providers[grant.provider] = { name: definition.name, package: definition.package, settings: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY }, models: definition.models };
    }
  }
  const config = { $schema: 'https://opencode.ai/config.json', provider };
  if (Object.keys(providers).length > 0) config.providers = providers;
  return config;
}

/**
 * The variable a space container carries OpenCode's start configuration in. OpenCode reads it
 * after every configuration file, the project's own `.opencode/opencode.json` among them,
 * measured on 2.0.32, and only when it starts: a file change reloads the files and not this.
 */
export const START_CONFIG_VARIABLE = 'OPENCODE_CONFIG_CONTENT';

const startConfigSchema = z.object({
  providers: z.record(providerIdSchema, z.object({
    settings: z.object({ baseURL: z.string(), apiKey: z.literal(WINDOW_PLACEHOLDER_KEY) }).strict(),
  }).strict()),
}).strict();

/**
 * What of the custom providers given at creation must win over a project's own definition of
 * them: the window as the address, with the placeholder key. Only that, since the container
 * keeps it for good: the SDK, the name and the models stay in the configuration file, so a
 * provider edited in Settings still reaches the space at its next start. Null when no custom
 * provider was given, so the container carries no variable.
 */
export function buildStartConfig(customProviderIds) {
  if (customProviderIds.length === 0) return null;
  const providers = {};
  for (const id of customProviderIds) providers[id] = { settings: { baseURL: spaceWindowUrl(id), apiKey: WINDOW_PLACEHOLDER_KEY } };
  return JSON.stringify({ providers });
}

/**
 * Whether a container's start configuration is one `buildStartConfig` makes: providers with
 * their own window and the placeholder key, and nothing else. Anything else in that
 * variable, a key above all, OpenCode inside would take as configuration.
 */
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
// What the row inside needs of a ChatGPT login's metadata: the account id the legacy Codex mode
// sends as a header, and the client id and scopes the ChatGPT login reads at load. Nothing else
// travels, so a key the host's plugin stores there one day, a cached model list among them
// today, stays on the host.
const CHATGPT_METADATA_KEYS = ['accountID', 'clientID', 'scopes'];
const chatgptRowMetadataOf = (login) => {
  const metadata = {};
  for (const key of CHATGPT_METADATA_KEYS) if (login.metadata[key] !== undefined) metadata[key] = login.metadata[key];
  return metadata;
};
// The ChatGPT modes read the provider's `baseURL` from the configuration, which wins over the
// plugin's own address, measured on 2.0.25; `http`, because the window carries no WebSocket,
// which the legacy mode opens by default.
const chatgptOptionsOf = (windowUrl) => ({ baseURL: windowUrl, transport: 'http' });
const CHATGPT_METHOD = { upstream: () => 'https://api.openai.com/v1', rowMetadata: chatgptRowMetadataOf, options: chatgptOptionsOf, ends: true };
const CODEX_METHOD = { upstream: () => CODEX_API, rowMetadata: chatgptRowMetadataOf, options: chatgptOptionsOf, ends: true };
// Where OpenCode's Copilot plugin sends a login's requests, `copilotBaseURL` in its
// `github-copilot.ts` at 2.0.25: the address GitHub told it at login, else the enterprise
// address, else GitHub's public one.
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
  // The row's address is where the plugin sends the model list and every turn: the window. The
  // enterprise address stays on the host, since the row's address wins over it.
  rowMetadata: (login, windowUrl) => ({ apiEndpoint: windowUrl }),
  // The plugin keeps the address it read from the row and reads no `baseURL` from the configuration.
  options: () => null,
  // The GitHub token has no end: the plugin stores `expires: 0` and has no refresh, so OpenCode
  // never renews it, and neither does the host's keeper. It lives until the user revokes it.
  ends: false,
};

// Each browser login method a space can be given, by provider and method, as OpenCode has them
// at 2.0.25: where OpenCode sends that method's requests, which the window forwards to with the
// real token; what of the login's metadata the row inside carries; what the provider
// configuration inside says; and whether the token ends. The space's row names the same method,
// so OpenCode inside sends the headers that upstream wants, with the row's placeholder token in
// `Authorization`, which the window replaces. A method not named here is refused: the host
// cannot know where its requests go. `auth.openai.com`, where the ChatGPT methods refresh, is on
// no list: the gatekeeper refuses it, and the host is the only refresher (decision 13).
const LOGIN_METHODS = new Map([
  ['openai/chatgpt-token-sharing', CHATGPT_METHOD],
  ['openai/chatgpt-browser', CODEX_METHOD],
  ['openai/chatgpt-headless', CODEX_METHOD],
  ['github-copilot/device', COPILOT_METHOD],
]);
const loginMethodOf = (provider, methodID) => LOGIN_METHODS.get(`${provider}/${methodID}`) ?? null;
/** The providers whose browser login a space can be given, in the order the map names them. */
export const LOGIN_PROVIDERS = Array.from(new Set(Array.from(LOGIN_METHODS.keys(), (key) => key.split('/')[0])));
/** The id of the one login row the host writes inside a space for a provider, so a replace finds it again. */
export const spaceLoginCredentialId = (provider) => `cred_openchamber_space_${provider}`;
// The id every provider's row shared before 7d; a removal takes it out of a space made then.
const LEGACY_LOGIN_CREDENTIAL_ID = 'cred_openchamber_space';
// OpenCode refreshes a login five minutes before `expires`. The row inside must never refresh,
// because it holds no refresh token and the issuer is refused, so its token ends in 2100.
const NEVER_EXPIRES = Date.UTC(2100, 0, 1);

/**
 * The window grant a host login makes: the upstream of its method, with the token as a bearer.
 * Null for a method this module does not know.
 */
export function loginGrantOf(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  return method ? { upstream: method.upstream(login), header: 'authorization', secret: login.access } : null;
}

/**
 * When a host login's token ends, in milliseconds since the epoch, or null for a token with no
 * end, Copilot's. A method this module does not know answers what the login says.
 */
export function loginEndOf(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  return method && !method.ends ? null : login.expires;
}

/** Whether a host login's token has ended at `nowMs`; a token with no end never has. */
export function loginEnded(provider, login, nowMs) {
  const end = loginEndOf(provider, login);
  return end !== null && end <= nowMs;
}

/**
 * The login row for OpenCode inside: the host login's method and what that method keeps of the
 * metadata, which names the account or the window and never a secret, with placeholder tokens
 * that never expire. A method this module does not know has no row.
 */
export function buildLoginRow(provider, login) {
  const method = loginMethodOf(provider, login.methodID);
  if (!method) throw new SpaceError('login_not_supported', `The ${provider} login was made in a way a space cannot be given (${login.methodID}).`);
  const metadata = method.rowMetadata(login, spaceWindowUrl(provider));
  const value = { type: 'oauth', methodID: login.methodID, access: WINDOW_PLACEHOLDER_KEY, refresh: WINDOW_PLACEHOLDER_KEY, expires: NEVER_EXPIRES };
  if (Object.keys(metadata).length > 0) value.metadata = metadata;
  return { id: spaceLoginCredentialId(provider), integrationID: provider, label: 'OpenChamber space', value };
}

// A chat larger than this is not taken out: the host reads one chat into memory at a time, and a
// space can answer with as much as it likes. The maintainer's call of 2026-09-30; the largest chat
// measured on a real OpenCode was 94 MB.
const CHAT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
// A chat that has not come whole in this time is not taken out, however slowly the space keeps
// sending: a space must not hold its own delete.
const CHAT_EXPORT_TIMEOUT_MS = 5 * 60_000;
// A login row is two small requests to OpenCode inside, which answers them in milliseconds.
const ROW_TIMEOUT_MS = 30_000;

// OpenCode's session id, checked before it goes into a path.
export const chatIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/);

const instantSchema = z.number().int().nonnegative();
const countSchema = z.number().nonnegative();

// What the host takes of a chat's record. Everything else the space says about it, its permissions,
// metadata, agent, model and revert among them, is dropped: an archive is read and never run.
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

// The messages travel whole; the host's OpenCode checks each one against its own schema on import.
const exportedChatSchema = z.object({
  data: z.object({
    info: exportedInfoSchema,
    messages: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()),
  }),
});

/**
 * Reads an answer from inside up to `cap` bytes and until `deadline`; a longer one is
 * `chat_too_large`, a slower one `chat_export_timed_out`.
 */
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

// Every tool of every agent refused in an archived chat, by OpenCode itself. The chat lives in the
// host's OpenCode, which VS Code, the OpenCode CLI and any other client reach without OpenChamber's
// server; a turn someone starts there anyway runs no tool on the host. OpenCode takes the last
// rule that matches, and a session's rules come after the agent's.
const ARCHIVED_CHAT_PERMISSIONS = Object.freeze([Object.freeze({ action: '*', resource: '*', effect: 'deny' })]);

/**
 * What the host's OpenCode imports for a chat of a deleted space: the checked record at the
 * archive's own directory, stamped archived, with every tool refused, and with `parentID` only
 * when the parent is in the same archive, so a space cannot hang its chat under a session of the
 * host's.
 */
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

/**
 * `exec` is the place operation, always for the space container. `requestInside` is the
 * dispatcher's own request to the server inside, which a chat is taken out through, and
 * `chatMaxBytes` and `chatTimeoutMs` the caps on one chat, smaller in the tests.
 */
export function createSpaceOpenCode({ exec, requestInside, chatMaxBytes = CHAT_EXPORT_MAX_BYTES, chatTimeoutMs = CHAT_EXPORT_TIMEOUT_MS }) {
  /**
   * Writes the whole configuration beside the project from the model grants the record holds;
   * `customProviders` holds the host's definition of each custom provider among them, by id.
   */
  const writeProviderConfig = async (spaceId, grants, customProviders = new Map()) => {
    const text = `${JSON.stringify(buildProviderConfig(grants, customProviders), null, 2)}\n`;
    const result = await exec(spaceId, [IMAGE_SH, '-c', writeConfigScriptOf(spaceId)], { stdin: text });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not write the provider configuration inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  /**
   * One chat of a space as OpenCode exports it, checked: `{ info, messages }`. A chat over the cap
   * is `chat_too_large`; anything else that does not come whole is `chat_export_failed`.
   */
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

  /** One request of the host's to OpenCode inside, answered with its status; the body is drained. */
  const askInside = async (spaceId, request) => {
    const headers = { accept: 'application/json' };
    if (request.body) headers['content-type'] = 'application/json';
    const response = await requestInside(spaceId, { ...request, headers, timeoutMs: ROW_TIMEOUT_MS });
    response.resume();
    await new Promise((resolve) => { response.on('end', resolve); response.on('error', resolve); response.on('close', resolve); });
    return response.statusCode;
  };

  /**
   * Takes the host's login row for a provider out of OpenCode inside; a row that is not there is
   * nothing to do. The one row of a space made before 7d, under the id every provider shared,
   * goes with it: OpenCode activates the newest remaining row of an integration when the active
   * one is removed, so a legacy row left behind would come back as the login.
   */
  const removeLogin = async (spaceId, provider) => {
    for (const id of [spaceLoginCredentialId(provider), LEGACY_LOGIN_CREDENTIAL_ID]) {
      const status = await askInside(spaceId, { method: 'DELETE', path: `/api/credential/${id}` });
      if (status !== 204 && status !== 200 && status !== 404) throw new SpaceError('space_setup_failed', `Could not remove the ${provider} login row inside the space: OpenCode answered ${status}`);
    }
  };

  /**
   * Writes the login row for a host login into OpenCode inside, replacing the one before: OpenCode
   * takes the new row as the provider's login at once and switches its ChatGPT mode on, measured
   * on 2.0.25. A row the agent made under the host's id is replaced like the host's own.
   */
  const writeLogin = async (spaceId, provider, login) => {
    await removeLogin(spaceId, provider);
    const status = await askInside(spaceId, { method: 'POST', path: '/api/credential', body: JSON.stringify(buildLoginRow(provider, login)) });
    if (status !== 200) throw new SpaceError('space_setup_failed', `Could not write the login row inside the space: OpenCode answered ${status}`);
  };

  return { writeProviderConfig, writeLogin, removeLogin, exportChat };
}
