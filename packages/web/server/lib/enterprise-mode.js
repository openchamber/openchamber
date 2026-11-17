import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';


const WINDOWS_PROGRAM_DATA = 'C:\\ProgramData';

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

const optionalText = z.string().trim().transform((value) => value || undefined).optional();

const policyFileSchema = z.object({
  enterpriseMode: z.boolean().optional(),
  organization: optionalText,
  relayUrl: optionalText,
  allowNetworkAccess: z.boolean().optional(),
  allowedExtensions: z.array(z.string().trim().min(1)).max(200).optional(),
  allowLocalExtensions: z.boolean().optional(),
  jev: z.object({ url: optionalText, model: optionalText, apiKey: optionalText }).optional(),
  opencodeBinary: optionalText,
  hideBuiltinSkillCatalogs: z.boolean().optional(),
}).refine((policy) => !policy.jev || policy.jev.url || (!policy.jev.model && !policy.jev.apiKey), {
  message: '"jev" needs a "url"',
  path: ['jev'],
});

const parsePolicyFile = (text) => {
  let raw;
  try {
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
  const { enterpriseMode, organization, relayUrl, allowNetworkAccess, allowedExtensions, allowLocalExtensions, jev, opencodeBinary, hideBuiltinSkillCatalogs } = parsed.data;
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
  };
};

const defaultReadFile = (filePath) => fs.readFileSync(filePath, 'utf8');

let lastWarning = null;
const warnOnce = (message) => {
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(`[enterprise] ${message}`);
};

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
 * Calls `onChange` once the policy in effect differs from the last read: a
 * managed OpenCode config written before the change still lists what the
 * policy now refuses (`guests/agent-context.js`), and only a rewrite takes it
 * out of the running OpenCode. A poll, since the policy file lives at a fixed
 * path that may not exist yet and is read on every use anyway.
 *
 * @param {{ onChange: () => void, intervalMs?: number, read?: () => object }} options
 * @returns {() => void} stops the watch
 */
export const watchEnterprisePolicy = ({ onChange, intervalMs = 15_000, read = readEnterprisePolicy }) => {
  let last = JSON.stringify(read());
  const timer = setInterval(() => {
    const next = JSON.stringify(read());
    if (next === last) return;
    last = next;
    onChange();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

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
      hideBuiltinSkillCatalogs: true,
    };
  }

  const fromFile = file.status === 'ok' ? file.policy : null;
  const fileGoverns = fromFile?.enterpriseMode === true;
  const enterpriseMode = fileGoverns || envFlag(env, 'OPENCHAMBER_ENTERPRISE_MODE');

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
    opencodeBinary: fromFile?.opencodeBinary ?? null,
    hideBuiltinSkillCatalogs: fromFile?.hideBuiltinSkillCatalogs === true,
  };
};

export const isEnterpriseMode = (options) => readEnterprisePolicy(options).enterpriseMode;

export const isNetworkAccessBlocked = (options) => {
  const policy = readEnterprisePolicy(options);
  return policy.enterpriseMode && !policy.allowNetworkAccess;
};

export const NETWORK_ACCESS_BLOCKED_ERROR = 'Enterprise mode keeps OpenChamber on this machine: it does not listen on a network address. '
  + 'An administrator can allow it with "allowNetworkAccess": true in the policy file, or OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 where the environment turns enterprise mode on.';

export const publicEnterprisePolicy = (options) => {
  const { enterpriseMode, source, organization, policyError, allowNetworkAccess, opencodeBinary } = readEnterprisePolicy(options);
  return { enterpriseMode, source, organization, policyError, networkAccessBlocked: enterpriseMode && !allowNetworkAccess, opencodeBinary };
};

// external: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/mcp/index.ts Remote MCP OAuth integration ids are mcp_ followed by 16 hash digits.
const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_-]+$/;

// external: https://github.com/anomalyco/opencode OpenCode routing folds case, duplicate slashes and escapes; policy checks must match the upstream handler.
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

// external: https://github.com/anomalyco/opencode MCP OAuth starts at connect/oauth and completes at connect/oauth/:attempt/complete.
const isMcpSignIn = (integrationId, rest) => (
  MCP_INTEGRATION_ID.test(integrationId)
  && rest[0]?.toLowerCase() === 'oauth'
  && (rest.length === 1 || (rest.length === 3 && ATTEMPT_ID.test(rest[1]) && rest[2].toLowerCase() === 'complete'))
);

export const isProviderConnectRequest = (method, requestPath) => {
  if (String(method).toUpperCase() !== 'POST') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return true;
  const [api, group, ...tail] = segments.map((segment) => segment.toLowerCase());
  if (api !== 'api') return false;
  // external: https://github.com/anomalyco/opencode POST /api/credential adds a key; /api/credential/:id/activate only selects an existing one.
  if (group === 'credential') return tail.length === 0;
  if (group === 'experimental') return tail[0] === 'integration' && tail[1] === 'wellknown';
  if (group !== 'integration' || tail[1] !== 'connect') return false;
  return !isMcpSignIn(segments[2], segments.slice(4));
};

export const ENTERPRISE_MODE_ERROR = 'Not available in enterprise mode: this server keeps conversations with the model providers configured in OpenCode.';

// external: https://github.com/anomalyco/opencode Since 2.0.20 GET /api/credential returns secrets; no UI client may read it.
export const isCredentialListRequest = (method, requestPath) => {
  const upper = String(method).toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return /^[\\/]*api(?:[\\/?#;]|$)/i.test(String(requestPath));
  return segments.length === 2 && segments[0].toLowerCase() === 'api' && segments[1].toLowerCase() === 'credential';
};

export const CREDENTIAL_LIST_ERROR = 'OpenChamber does not hand stored provider keys to clients.';
