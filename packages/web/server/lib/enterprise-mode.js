import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/**
 * Enterprise mode: an administrator's promise that conversation content goes
 * only to the model providers configured in OpenCode. Two sources turn it on,
 * and either one is enough:
 * - the machine policy file (`policyFilePaths`), which only an administrator
 *   can write and a device manager can roll out; nothing a user sets can
 *   turn off what it turns on;
 * - `OPENCHAMBER_ENTERPRISE_MODE=1` (or `true`) in the server's environment,
 *   which includes the login-shell snapshot. Meant for servers and containers,
 *   where the administrator owns the environment.
 * Read at every use, so a changed file applies without a restart.
 *
 * The policy file also pins the self-hosted relay and the Jev endpoint, and
 * can allow network access. Who decides those follows who turned the mode on:
 * - the file turned it on: only the file's values count. The environment is
 *   the user's to edit, so a variable there must not reopen what the
 *   administrator left closed (point Jev at an endpoint of their own, say);
 * - otherwise (the environment turned it on, or the mode is off): a value in
 *   the file wins over its variable, and the variable fills the gap.
 * A file that exists but cannot be read or parsed turns enterprise mode on,
 * pins nothing and allows nothing: a broken policy must not quietly lift the
 * protection it was meant to give.
 *
 * Each feature that could send conversation content anywhere else checks it
 * at its own server boundary:
 * - Model providers come only from the OpenCode config: connecting one,
 *   signing in, adding a key or creating a custom provider through this
 *   server is refused, as is probing a custom provider's model endpoint
 *   (`opencode/routes.js`). OpenCode's `provider.use`
 *   policy is the real lock; this closes the way in through the app.
 *   Signing in to a remote MCP server from the OpenCode config uses the same
 *   routes and stays allowed.
 * - Jev classification is off, unless the administrator pinned their own
 *   endpoint (`routing/runtime.js`).
 * - External tunnels are refused: Cloudflare and ngrok see plain text, and
 *   Tailscale opens this machine to other devices (`tunnels`).
 * - The private relay runs only on a pinned self-hosted endpoint
 *   (`relay/service.js`).
 * - Speech and transcription go only to servers on this machine (`tts`,
 *   `dictation`).
 * - Push notifications carry no message text or session name (`notifications`).
 * - Update checks still run but never report usage (`package-manager.js`).
 * - Environment variables from Settings and `opencode service set env` do
 *   not reach the managed OpenCode: one could carry a provider key
 *   (`environment/runtime.js`). Git, the terminal and exec still get them.
 * - The draw.io diagram editor, diagrams.net's own page in a frame, is not
 *   loaded; a .drawio file opens as its XML (`packages/ui` FilesView). The
 *   crossing happens in the browser, so the UI is where it is held back.
 * - Web fonts that load from a public CDN fall back to the system fonts
 *   (`packages/ui` useFontPreferences); the stored choice is kept.
 * - The integrations catalog, a bundled list of outside services to install,
 *   is hidden (`packages/ui` SidebarHeader); administrator-curated sources for
 *   it do not exist yet. MCP, plugin and skill entry in Settings is unchanged.
 * - The agent image tool (`openchamber-control/generate-image.js`) is not
 *   gated: it reaches an image model through OpenCode, so `provider.use`
 *   covers it like any other provider (maintainer decision, 2026-10-27).
 * - The Settings card that installs the Claude Code plugin, a model provider,
 *   is hidden (`packages/ui` IntegrationsPage). The plugin itself is not
 *   refused: OpenCode's `provider.use` policy covers `claude-code` like any
 *   other provider.
 * - The server listens only on this machine unless network access is allowed
 *   (`allowNetworkAccess` / `OPENCHAMBER_ALLOW_NETWORK_ACCESS`): it refuses
 *   to start on a network address and drops connections from other machines
 *   (`../index.js`); the desktop shell binds loopback (`packages/electron`).
 *   Pairing a device then goes through a pinned relay only.
 * - Extensions that could send what they see elsewhere (`network`, `origins`,
 *   `service`, and `transcript`, session content posted to such a service)
 *   install and run only from a Git repository the administrator
 *   listed (`allowedExtensions` / `OPENCHAMBER_ALLOWED_EXTENSIONS`), or from a
 *   local folder where `allowLocalExtensions` /
 *   `OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS` allows it; see `guests/enterprise.js`.
 *   An allowed extension serving as a notification channel gets the kind's
 *   generic title with no body, session name or directory, as the phone does
 *   (`notifications/runtime.js` `sendToChannels`).
 *
 * The file can also pin the OpenCode CLI (`opencodeBinary`), with or without
 * enterprise mode: managed OpenCode then starts only from that path, never
 * falls back to the bundled CLI or PATH, ignores the user's binary setting,
 * and OpenChamber neither installs nor upgrades it (`opencode/env-runtime.js`,
 * `packages/vscode/src/opencode.ts`).
 *
 * The file can also hide the skills catalogs OpenChamber ships with
 * (`hideBuiltinSkillCatalogs`), with or without enterprise mode, so the only
 * catalogs on offer are the ones the organization added
 * (`skills-catalog/curated-sources.js`, `packages/vscode/src/skillsCatalog.ts`).
 *
 * The file can also allow exact plain-HTTP origins for Git hosting providers
 * (`allowedInsecureGitOrigins`), with or without enterprise mode: an
 * administrator who runs a forge (GitLab, Gitea, Forgejo, Gerrit) on an
 * intranet without TLS lists its origins, and the app accepts them for
 * instance, binding, credential and transport validation where HTTPS is
 * otherwise required. Only an exact `http://host[:port]` origin decides; a
 * malformed entry counts as unset, and extension-provided forges stay
 * loopback-only. The same list exists as a user setting (Settings → Git,
 * persisted in `preferences.json` as one-per-line text under
 * `allowedInsecureGitOrigins`): while enterprise mode is off the two sources
 * merge, and once the mode is on only the file counts — widening plaintext
 * trust never becomes the user's move.
 * `allowedInsecureGitOrigins()` resolves both for the consumers that check it.
 *
 * The VS Code extension host, which runs no OpenChamber server, reads the
 * same policy through this module for the parts it has (provider connection,
 * update checks).
 */

const WINDOWS_PROGRAM_DATA = 'C:\\ProgramData';

/**
 * Where the machine policy may live, most authoritative first. The paths are
 * fixed on purpose: a location a user could redirect (an environment variable,
 * a setting) would let them point it at an empty file. On Windows the
 * `ProgramData` variable is consulted only after the fixed location, so
 * redirecting it cannot hide a policy the administrator placed there.
 */
export const policyFilePaths = ({ platform = process.platform, env = process.env } = {}) => {
  if (platform === 'darwin') return ['/Library/Application Support/OpenChamber/policy.json'];
  if (platform === 'win32') {
    const fixed = path.win32.join(WINDOWS_PROGRAM_DATA, 'OpenChamber', 'policy.json');
    const programData = (env.ProgramData ?? '').trim();
    const fromEnv = programData ? path.win32.join(programData, 'OpenChamber', 'policy.json') : null;
    return fromEnv && fromEnv.toLowerCase() !== fixed.toLowerCase() ? [fixed, fromEnv] : [fixed];
  }
  return ['/etc/openchamber/policy.json'];
};

// A blank string counts as unset, so a template with empty fields pins nothing.
const optionalText = z.string().trim().transform((value) => value || undefined).optional();

const policyFileSchema = z.object({
  enterpriseMode: z.boolean().optional(),
  organization: optionalText,
  relayUrl: optionalText,
  allowNetworkAccess: z.boolean().optional(),
  // Git repository URLs, not package ids: a package names its own id, so a
  // user could ship any code under an allowed one.
  allowedExtensions: z.array(z.string().trim().min(1)).max(200).optional(),
  allowLocalExtensions: z.boolean().optional(),
  jev: z.object({ url: optionalText, model: optionalText, apiKey: optionalText }).optional(),
  opencodeBinary: optionalText,
  hideBuiltinSkillCatalogs: z.boolean().optional(),
  // Exact plain-HTTP origins of self-hosted Git hosts the administrator trusts;
  // consumers validate each at use and treat a malformed entry as unset.
  allowedInsecureGitOrigins: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
  // Where the model catalog (models.dev `api.json` format) is read from, for
  // networks that cannot reach models.dev. Consumers validate it at use
  // (`readPinnedModelsDevUrl`) and treat a malformed value as unset.
  modelsDevUrl: optionalText,
  // Replaces the built-in skill catalogs. An entry the schema cannot read
  // makes the whole file invalid, which fails closed (no catalog at all).
  skillsCatalogSources: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(128),
    description: optionalText,
    source: z.string().trim().min(1).max(512),
    defaultSubpath: optionalText,
    excludedSkills: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
  })).max(50).optional(),
}).refine((policy) => !policy.jev || policy.jev.url || (!policy.jev.model && !policy.jev.apiKey), {
  message: '"jev" needs a "url"',
  path: ['jev'],
});

/** The file's content; throws an Error saying what is wrong with it. */
const parsePolicyFile = (text) => {
  let raw;
  try {
    // Windows PowerShell 5 writes UTF-8 with a byte-order mark.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`not valid JSON (${error.message})`);
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.length > 0 ? `"${issue.path.join('.')}": ` : '';
    throw new Error(`${field}${issue.message}`);
  }
  const { enterpriseMode, organization, relayUrl, allowNetworkAccess, allowedExtensions, allowLocalExtensions, jev, opencodeBinary, hideBuiltinSkillCatalogs, allowedInsecureGitOrigins, modelsDevUrl, skillsCatalogSources } = parsed.data;
  return {
    enterpriseMode: enterpriseMode === true,
    organization: organization ?? null,
    relayUrl,
    allowNetworkAccess,
    allowedExtensions,
    allowLocalExtensions,
    jev: jev?.url ? { url: jev.url, model: jev.model ?? null, apiKey: jev.apiKey ?? null } : undefined,
    opencodeBinary: opencodeBinary ?? null,
    hideBuiltinSkillCatalogs: hideBuiltinSkillCatalogs === true,
    allowedInsecureGitOrigins: allowedInsecureGitOrigins ?? [],
    modelsDevUrl: modelsDevUrl ?? null,
    skillsCatalogSources: skillsCatalogSources ?? [],
  };
};

const defaultReadFile = (filePath) => fs.readFileSync(filePath, 'utf8');

let lastWarning = null;
const warnOnce = (message) => {
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(`[enterprise] ${message}`);
};

/**
 * The machine policy file: `{ status: 'absent' }`, `{ status: 'ok', path,
 * policy }`, or `{ status: 'invalid', path, error }` when it exists but cannot
 * be used.
 */
const readPolicyFile = ({ platform = process.platform, env = process.env, readFile = defaultReadFile } = {}) => {
  for (const filePath of policyFilePaths({ platform, env })) {
    let text;
    try {
      text = readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      const message = `cannot read ${filePath}: ${error?.message || error}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
    try {
      return { status: 'ok', path: filePath, policy: parsePolicyFile(text) };
    } catch (error) {
      const message = `${filePath}: ${error.message}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
  }
  return { status: 'absent' };
};

const envFlag = (env, name) => {
  const value = (env[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
};

const envString = (env, name) => (env[name] ?? '').trim() || null;

const envList = (env, name) => (env[name] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

/**
 * The policy in effect, from the file and the environment together.
 * `relayUrl` and `jev` are the raw pinned values; their consumers validate
 * them and treat an invalid one as unset. `source` says where enterprise mode
 * came from, for the UI and the logs.
 */
export const readEnterprisePolicy = (options = {}) => {
  const env = options.env ?? process.env;
  const file = readPolicyFile(options);

  if (file.status === 'invalid') {
    return {
      enterpriseMode: true,
      source: 'policy-file',
      organization: null,
      policyError: file.error,
      relayUrl: null,
      jev: null,
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
      opencodeBinary: null,
      // Fails closed like the rest: a broken policy allows no plaintext origin it might have withheld.
      allowedInsecureGitOrigins: [],
      // Fails closed like the rest: a broken policy offers no catalog it might have hidden.
      hideBuiltinSkillCatalogs: true,
      // Fails closed like the rest: a broken policy pins no endpoint and offers no catalog it might have replaced.
      modelsDevUrl: null,
      skillsCatalogSources: [],
    };
  }

  const fromFile = file.status === 'ok' ? file.policy : null;
  const fileGoverns = fromFile?.enterpriseMode === true;
  const enterpriseMode = fileGoverns || envFlag(env, 'OPENCHAMBER_ENTERPRISE_MODE');

  // With the file in charge the environment adds nothing (see above).
  const envJevUrl = fileGoverns ? null : envString(env, 'OPENCHAMBER_JEV_URL');
  const jev = fromFile?.jev
    ?? (envJevUrl
      ? { url: envJevUrl, model: envString(env, 'OPENCHAMBER_JEV_MODEL'), apiKey: envString(env, 'OPENCHAMBER_JEV_API_KEY') }
      : null);
  const relayUrl = fromFile?.relayUrl ?? (fileGoverns ? null : envString(env, 'OPENCHAMBER_RELAY_URL'));
  const allowNetworkAccess = fromFile?.allowNetworkAccess
    ?? (fileGoverns ? false : envFlag(env, 'OPENCHAMBER_ALLOW_NETWORK_ACCESS'));
  const allowedExtensions = fromFile?.allowedExtensions
    ?? (fileGoverns ? [] : envList(env, 'OPENCHAMBER_ALLOWED_EXTENSIONS'));
  const allowLocalExtensions = fromFile?.allowLocalExtensions
    ?? (fileGoverns ? false : envFlag(env, 'OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS'));

  return {
    enterpriseMode,
    source: fileGoverns ? 'policy-file' : enterpriseMode ? 'environment' : null,
    organization: fromFile?.organization ?? null,
    policyError: null,
    relayUrl,
    jev,
    allowNetworkAccess,
    allowedExtensions,
    allowLocalExtensions,
    // File only, in or out of enterprise mode: OPENCODE_BINARY already lets a
    // user pick a binary, and a pin they could override would not be one.
    opencodeBinary: fromFile?.opencodeBinary ?? null,
    // File only, in or out of enterprise mode, for the same reason.
    hideBuiltinSkillCatalogs: fromFile?.hideBuiltinSkillCatalogs === true,
    // File only, in or out of enterprise mode, for the same reason.
    allowedInsecureGitOrigins: fromFile?.allowedInsecureGitOrigins ?? [],
    // File only, in or out of enterprise mode, for the same reason.
    modelsDevUrl: fromFile?.modelsDevUrl ?? null,
    skillsCatalogSources: fromFile?.skillsCatalogSources ?? [],
  };
};

/**
 * The model catalog URL the administrator pinned, or null: unset, or not a
 * plain `http(s)` URL without credentials (a malformed value counts as unset).
 */
export const readPinnedModelsDevUrl = (options) => {
  const value = readEnterprisePolicy(options).modelsDevUrl;
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
};

export const isEnterpriseMode = (options) => readEnterprisePolicy(options).enterpriseMode;

/**
 * The user's own plain-HTTP Git origins: the `allowedInsecureGitOrigins`
 * profile key (Settings → Git), one origin per line, read from
 * `preferences.json` the same way `small-model/index.js` reads profile
 * settings. A missing or broken file, or a value that is not text, adds
 * nothing. Consulted only while enterprise mode is off; entries are validated
 * by the caller like the file's.
 */
const readProfileInsecureGitOrigins = ({ env = process.env, readFile = defaultReadFile } = {}) => {
  const dir = env.OPENCHAMBER_DATA_DIR
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  let text;
  try {
    text = readFile(path.join(dir, 'preferences.json'));
  } catch {
    return [];
  }
  let fields;
  try {
    fields = JSON.parse(text.replace(/^\uFEFF/, ''))?.fields;
  } catch {
    return [];
  }
  const parsed = z.string().safeParse(fields?.allowedInsecureGitOrigins?.value);
  return parsed.success
    ? parsed.data.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
};

/**
 * One exact plain-HTTP origin, or null: not text, over 512 characters, a
 * non-`http:` scheme, credentials, a path, a query, a fragment, or a hostname
 * no real origin can have (empty, wildcard). A missing scheme is repaired as
 * `http://`, so `git.internal:8080` is the same origin as `http://git.internal:8080`.
 * The Settings → Git parser in `packages/ui/src/lib/settings/parsers.ts`
 * mirrors this by hand, and `opencode/settings-helpers.js` reuses it directly:
 * what persists and the trust it buys never diverge.
 */
export const normalizeInsecureGitOrigin = (raw) => {
  const parsed = z.string().safeParse(raw);
  const value = parsed.success ? parsed.data.trim() : '';
  if (!value || value.length > 512) return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  if (!url.hostname || url.hostname.includes('*')) return null;
  return url.origin;
};

/**
 * The exact plain-HTTP origins allowed for Git hosting providers: the policy
 * file's `allowedInsecureGitOrigins` plus, while enterprise mode is off, the
 * user setting of the same name in `preferences.json`. Entries go through
 * `normalizeInsecureGitOrigin`; a malformed one counts as unset. Read at every
 * use, like the rest of the policy; the callers that consult it are
 * `source-control/origin-instance.js`, the Git transport checks
 * (`git/network-operation-plan.js`, `git/credential-resolver.js`,
 * `git/network-operation-storage.js`, `git/repository-credential-runtime.js`)
 * and the provider listing route.
 */
export const allowedInsecureGitOrigins = (options) => {
  const policy = readEnterprisePolicy(options);
  const entries = [...policy.allowedInsecureGitOrigins];
  if (!policy.enterpriseMode) entries.push(...readProfileInsecureGitOrigins(options));
  const origins = new Set();
  for (const entry of entries) {
    const origin = normalizeInsecureGitOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
};

/** Whether enterprise mode keeps this server off the network (loopback only). */
export const isNetworkAccessBlocked = (options) => {
  const policy = readEnterprisePolicy(options);
  return policy.enterpriseMode && !policy.allowNetworkAccess;
};

export const NETWORK_ACCESS_BLOCKED_ERROR = 'Enterprise mode keeps OpenChamber on this machine: it does not listen on a network address. '
  + 'An administrator can allow it with "allowNetworkAccess": true in the policy file, or OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 where the environment turns enterprise mode on.';

/** What a client may know about the policy; pinned endpoints and keys stay on the server. */
export const publicEnterprisePolicy = (options) => {
  const { enterpriseMode, source, organization, policyError, allowNetworkAccess, opencodeBinary } = readEnterprisePolicy(options);
  return { enterpriseMode, source, organization, policyError, networkAccessBlocked: enterpriseMode && !allowNetworkAccess, opencodeBinary };
};

// OpenCode registers every remote MCP server with OAuth as an integration
// whose id is `mcp_` plus 16 hex digits of a hash of its name and URL
// (`packages/core/src/mcp/index.ts` upstream). Signing in to one reaches a
// tool server from the OpenCode config, not a model provider.
const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The path segments as OpenCode 2.0.18 to 2.0.20 route them. Bun's URL parsing turns
 * `\` into `/`; OpenCode's router (`effect/unstable/http` FindMyWay:
 * case-insensitive, duplicate and trailing slashes ignored, `safeDecodeURI`)
 * ends the path at `?`, `#` or `;` and decodes percent escapes. So `/API//integration\%6Fpenai/connect/key;x` reaches the same
 * handler as `/api/integration/openai/connect/key`. Null when a segment cannot
 * be decoded or is a dot segment: such a path is refused. Recheck this list
 * when OpenCode changes its router.
 */
const routeSegments = (requestPath) => {
  const pathOnly = String(requestPath).split(/[?#;]/, 1)[0];
  const segments = [];
  for (const raw of pathOnly.split(/[\\/]/)) {
    if (!raw) continue;
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..') return null;
    segments.push(segment);
  }
  return segments;
};

// POST `connect/oauth` starts an MCP sign-in, `connect/oauth/:attempt/complete`
// finishes it with a pasted code.
const isMcpSignIn = (integrationId, rest) => (
  MCP_INTEGRATION_ID.test(integrationId)
  && rest[0]?.toLowerCase() === 'oauth'
  && (rest.length === 1 || (rest.length === 3 && ATTEMPT_ID.test(rest[1]) && rest[2].toLowerCase() === 'complete'))
);

/**
 * Whether a request to OpenCode would add a way to reach a model provider:
 * every POST under `/api/integration/:id/connect` (key, oauth start and
 * complete, command, external since 2.0.25), storing a key with `POST /api/credential`, and adding a
 * well-known integration. Signing in to a
 * remote MCP server goes through the same routes and stays allowed. Reads,
 * cancelling an attempt and removing or switching an existing account stay
 * allowed too: they only narrow access. A path that cannot be read safely
 * counts as a connect.
 */
export const isProviderConnectRequest = (method, requestPath) => {
  if (String(method).toUpperCase() !== 'POST') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return true;
  const [api, group, ...tail] = segments.map((segment) => segment.toLowerCase());
  if (api !== 'api') return false;
  // `POST /api/credential` stores a new key (OpenCode 2.0.20);
  // `/api/credential/:id/activate` only switches between existing ones.
  if (group === 'credential') return tail.length === 0;
  if (group === 'experimental') return tail[0] === 'integration' && tail[1] === 'wellknown';
  if (group !== 'integration' || tail[1] !== 'connect') return false;
  return !isMcpSignIn(segments[2], segments.slice(4));
};

export const ENTERPRISE_MODE_ERROR = 'Not available in enterprise mode: this server keeps conversations with the model providers configured in OpenCode.';

/**
 * Whether a request asks OpenCode for every stored credential. Since 2.0.20
 * `GET /api/credential` answers with the secrets themselves. This server and
 * the VS Code extension host read it for themselves (`opencode/auth.js`); no
 * client gets it, in or out of enterprise mode, because anyone signed in to
 * the UI (over a tunnel or a paired phone too) would otherwise read every key.
 * It lives here because it needs the same reading of an OpenCode path as the
 * provider-connect check. A path under `/api` that cannot be read safely
 * counts as a read; anything else never reaches OpenCode and is left alone.
 */
export const isCredentialListRequest = (method, requestPath) => {
  const upper = String(method).toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return /^[\\/]*api(?:[\\/?#;]|$)/i.test(String(requestPath));
  return segments.length === 2 && segments[0].toLowerCase() === 'api' && segments[1].toLowerCase() === 'credential';
};

export const CREDENTIAL_LIST_ERROR = 'OpenChamber does not hand stored provider keys to clients.';
