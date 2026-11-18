import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export type EnterprisePolicySource = 'policy-file' | 'environment';

export interface EnterprisePolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
}

export interface EnterprisePolicy {
  enterpriseMode: boolean;
  source: EnterprisePolicySource | null;
  organization: string | null;
  policyError: string | null;
  relayUrl: string | null;
  jev: { url: string; model: string | null; apiKey: string | null } | null;
  allowNetworkAccess: boolean;
  allowedExtensions: string[];
  allowLocalExtensions: boolean;
  opencodeBinary: string | null;
  hideBuiltinSkillCatalogs: boolean;
}

export type PublicEnterprisePolicy = Pick<EnterprisePolicy, 'enterpriseMode' | 'source' | 'organization' | 'policyError' | 'opencodeBinary'> & { networkAccessBlocked: boolean };

const hasErrorDetails = (value: unknown): value is { code?: unknown; message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const WINDOWS_PROGRAM_DATA = 'C:\\ProgramData';

export const policyFilePaths = ({ platform = process.platform, env = process.env }: Pick<EnterprisePolicyOptions, 'platform' | 'env'> = {}) => {
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

const parsePolicyFile = (text: string) => {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`not valid JSON (${hasErrorDetails(error) ? error.message : undefined})`);
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    if (!issue) throw parsed.error;
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

const defaultReadFile = (filePath: string) => fs.readFileSync(filePath, 'utf8');

let lastWarning: string | null = null;
const warnOnce = (message: string) => {
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(`[enterprise] ${message}`);
};

type PolicyFileRead =
  | { status: 'invalid'; path: string; error: string }
  | { status: 'ok'; path: string; policy: ReturnType<typeof parsePolicyFile> }
  | { status: 'absent' };

const readPolicyFile = ({ platform = process.platform, env = process.env, readFile = defaultReadFile }: EnterprisePolicyOptions = {}): PolicyFileRead => {
  for (const filePath of policyFilePaths({ platform, env })) {
    let text;
    try {
      text = readFile(filePath);
    } catch (error) {
      if (hasErrorDetails(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      const message = `cannot read ${filePath}: ${hasErrorDetails(error) ? error.message || error : error}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
    try {
      return { status: 'ok', path: filePath, policy: parsePolicyFile(text) };
    } catch (error) {
      const message = `${filePath}: ${hasErrorDetails(error) ? error.message : undefined}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
  }
  return { status: 'absent' };
};

const envFlag = (env: NodeJS.ProcessEnv, name: string) => {
  const value = (env[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
};

const envString = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').trim() || null;

const envList = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

export const watchEnterprisePolicy = ({ onChange, intervalMs = 15_000, read = readEnterprisePolicy }: {
  onChange: () => void;
  intervalMs?: number;
  read?: () => EnterprisePolicy;
}) => {
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

export const readEnterprisePolicy = (options: EnterprisePolicyOptions = {}): EnterprisePolicy => {
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

export const isEnterpriseMode = (options?: EnterprisePolicyOptions) => readEnterprisePolicy(options).enterpriseMode;

export const isNetworkAccessBlocked = (options?: EnterprisePolicyOptions) => {
  const policy = readEnterprisePolicy(options);
  return policy.enterpriseMode && !policy.allowNetworkAccess;
};

export const NETWORK_ACCESS_BLOCKED_ERROR = 'Enterprise mode keeps OpenChamber on this machine: it does not listen on a network address. '
  + 'An administrator can allow it with "allowNetworkAccess": true in the policy file, or OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 where the environment turns enterprise mode on.';

export const publicEnterprisePolicy = (options?: EnterprisePolicyOptions): PublicEnterprisePolicy => {
  const { enterpriseMode, source, organization, policyError, allowNetworkAccess, opencodeBinary } = readEnterprisePolicy(options);
  return { enterpriseMode, source, organization, policyError, networkAccessBlocked: enterpriseMode && !allowNetworkAccess, opencodeBinary };
};

const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_-]+$/;

const routeSegments = (requestPath: string) => {
  const [pathOnly = ''] = String(requestPath).split(/[?#;]/, 1);
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

const isMcpSignIn = (integrationId: string | undefined, rest: string[]) => (
  MCP_INTEGRATION_ID.test(String(integrationId))
  && rest[0]?.toLowerCase() === 'oauth'
  && (rest.length === 1 || (rest.length === 3 && ATTEMPT_ID.test(String(rest[1])) && rest[2]?.toLowerCase() === 'complete'))
);

export const isProviderConnectRequest = (method: string, requestPath: string) => {
  if (String(method).toUpperCase() !== 'POST') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return true;
  const [api, group, ...tail] = segments.map((segment) => segment.toLowerCase());
  if (api !== 'api') return false;
  if (group === 'credential') return tail.length === 0;
  if (group === 'experimental') return tail[0] === 'integration' && tail[1] === 'wellknown';
  if (group !== 'integration' || tail[1] !== 'connect') return false;
  return !isMcpSignIn(segments[2], segments.slice(4));
};

export const ENTERPRISE_MODE_ERROR = 'Not available in enterprise mode: this server keeps conversations with the model providers configured in OpenCode.';

export const isCredentialListRequest = (method: string, requestPath: string) => {
  const upper = String(method).toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return /^[\\/]*api(?:[\\/?#;]|$)/i.test(String(requestPath));
  return segments.length === 2 && segments[0]?.toLowerCase() === 'api' && segments[1]?.toLowerCase() === 'credential';
};

export const CREDENTIAL_LIST_ERROR = 'OpenChamber does not hand stored provider keys to clients.';
