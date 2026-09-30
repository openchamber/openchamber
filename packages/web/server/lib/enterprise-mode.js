import fs from 'node:fs';
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
 *   server is refused (`opencode/routes.js`). OpenCode's `provider.use`
 *   policy is the real lock; this closes the way in through the app.
 *   Signing in to a remote MCP server from the OpenCode config uses the same
 *   routes and stays allowed.
 * - Jev classification is off, unless the administrator pinned their own
 *   endpoint (`routing/runtime.js`).
 * - External tunnels are refused: their provider sees plain text (`tunnels`).
 * - The private relay runs only on a pinned self-hosted endpoint
 *   (`relay/service.js`).
 * - Speech and transcription go only to servers on this machine (`tts`,
 *   `dictation`).
 * - Push notifications carry no message text or session name (`notifications`).
 * - Update checks still run but never report usage (`package-manager.js`).
 * - The server listens only on this machine unless network access is allowed
 *   (`allowNetworkAccess` / `OPENCHAMBER_ALLOW_NETWORK_ACCESS`): it refuses
 *   to start on a network address and drops connections from other machines
 *   (`../index.js`); the desktop shell binds loopback (`packages/electron`).
 *   Pairing a device then goes through a pinned relay only.
 * - Extensions that could send what they see elsewhere (`network`, `origins`,
 *   `service`) install and run only from a Git repository the administrator
 *   listed (`allowedExtensions` / `OPENCHAMBER_ALLOWED_EXTENSIONS`), or from a
 *   local folder where `allowLocalExtensions` /
 *   `OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS` allows it; see `guests/enterprise.js`.
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
  const { enterpriseMode, organization, relayUrl, allowNetworkAccess, allowedExtensions, allowLocalExtensions, jev } = parsed.data;
  return {
    enterpriseMode: enterpriseMode === true,
    organization: organization ?? null,
    relayUrl,
    allowNetworkAccess,
    allowedExtensions,
    allowLocalExtensions,
    jev: jev?.url ? { url: jev.url, model: jev.model ?? null, apiKey: jev.apiKey ?? null } : undefined,
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
  };
};

export const isEnterpriseMode = (options) => readEnterprisePolicy(options).enterpriseMode;

/** Whether enterprise mode keeps this server off the network (loopback only). */
export const isNetworkAccessBlocked = (options) => {
  const policy = readEnterprisePolicy(options);
  return policy.enterpriseMode && !policy.allowNetworkAccess;
};

export const NETWORK_ACCESS_BLOCKED_ERROR = 'Enterprise mode keeps OpenChamber on this machine: it does not listen on a network address. '
  + 'An administrator can allow it with "allowNetworkAccess": true in the policy file, or OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 where the environment turns enterprise mode on.';

/** What a client may know about the policy; pinned endpoints and keys stay on the server. */
export const publicEnterprisePolicy = (options) => {
  const { enterpriseMode, source, organization, policyError, allowNetworkAccess } = readEnterprisePolicy(options);
  return { enterpriseMode, source, organization, policyError, networkAccessBlocked: enterpriseMode && !allowNetworkAccess };
};

// OpenCode registers every remote MCP server with OAuth as an integration
// whose id is `mcp_` plus 16 hex digits of a hash of its name and URL
// (`packages/core/src/mcp/index.ts` upstream). Signing in to one reaches a
// tool server from the OpenCode config, not a model provider.
const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The path segments as OpenCode 2.0.18 routes them. Bun's URL parsing turns
 * `\` into `/`; its router (find-my-way-ts, case-insensitive, duplicate
 * slashes ignored) ends the path at `?`, `#` or `;` and decodes percent
 * escapes. So `/API//integration\%6Fpenai/connect/key;x` reaches the same
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
 * complete, command) and adding a well-known integration. Signing in to a
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
  if (group === 'experimental') return tail[0] === 'integration' && tail[1] === 'wellknown';
  if (group !== 'integration' || tail[1] !== 'connect') return false;
  return !isMcpSignIn(segments[2], segments.slice(4));
};

export const ENTERPRISE_MODE_ERROR = 'Not available in enterprise mode: this server keeps conversations with the model providers configured in OpenCode.';
