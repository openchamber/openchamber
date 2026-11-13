import React from 'react';
import { z } from 'zod';
import type { I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const credentialSchema = z.enum(['none', 'stored', 'missing', 'authorized', 'authorization_required']);

const connectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http']),
  target: z.object({ kind: z.enum(['command', 'package', 'url']), label: z.string() }),
  credential: credentialSchema,
});
export type ProtectedConnection = z.infer<typeof connectionSchema>;

const findingSchema = z.object({
  code: z.string(),
  level: z.enum(['error', 'unknown', 'warning']),
  subject: z.string().optional(),
});

const serviceSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    status: z.object({
      // Whether the agent's account can open the admin socket too (stage 1: shared).
      administration: z.enum(['shared', 'separate']),
      enforcement: z.object({
        status: z.enum(['protected', 'unverified', 'unprotected']),
        findings: z.array(findingSchema),
      }),
      connections: z.array(connectionSchema),
    }),
  }),
  z.object({
    state: z.enum(['unreachable', 'permission_denied', 'invalid_response', 'not_installed', 'invalid_client_config', 'unsupported_platform']),
  }),
]);

const selectionSchema = z.object({ connection: z.string(), disabled: z.literal(true).optional() });
const selectionMapSchema = z.record(z.string(), selectionSchema);

const statusSchema = z.object({
  host: z.object({ supported: z.boolean() }),
  service: serviceSchema,
  selections: z.object({
    global: selectionMapSchema,
    project: selectionMapSchema.nullable(),
    effective: selectionMapSchema,
  }).nullable(),
  selectionsError: z.string().nullable(),
});
export type ProtectedMcpStatus = z.infer<typeof statusSchema>;

// The definition grammar of the broker (`service/definitions.js`), as it
// answers it: normalized, so `args`, `env`, `headers` and `policy` are always
// present. The broker validates every value; this only reads the shapes. Each
// value that may be text or a reference is tagged here, once, with its kind.
const stateSchema = z.object({ state: z.string() });
const packageCommandSchema = z.object({ package: z.string(), version: z.string(), bin: z.string() });
const secretSchema = z.object({ secret: z.string() });
const secretFileSchema = z.object({ secretFile: z.string() });
const secretHeaderSchema = z.object({ secret: z.string(), prefix: z.string().optional() });
const commandSchema = z.union([
  z.string().transform((path) => ({ kind: 'path' as const, path })),
  packageCommandSchema.transform((command) => ({ kind: 'package' as const, ...command })),
]);
const argumentSchema = z.union([
  z.string().transform((value) => ({ kind: 'text' as const, value })),
  stateSchema.transform(({ state }) => ({ kind: 'state' as const, value: state })),
]);
const envValueSchema = z.union([
  z.string().transform((text) => ({ kind: 'text' as const, text })),
  secretSchema.transform(({ secret }) => ({ kind: 'secret' as const, slot: secret })),
  secretFileSchema.transform(({ secretFile }) => ({ kind: 'secretFile' as const, slot: secretFile })),
  stateSchema.transform(({ state }) => ({ kind: 'state' as const, text: state })),
]);
const headerValueSchema = z.union([
  z.string().transform((text) => ({ kind: 'text' as const, text })),
  secretHeaderSchema
    .transform(({ secret, prefix }) => ({ kind: 'secret' as const, slot: secret, prefix: prefix ?? '' })),
]);
const oauthSchema = z.object({
  scopes: z.array(z.string()),
  clientId: z.string().optional(),
  clientSecret: secretSchema.optional(),
  issuer: z.string().optional(),
  redirectUri: z.string().optional(),
});
const policySchema = z.object({
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  defaultArguments: z.record(z.string(), z.string()).optional(),
});
const stdioSchema = z.object({
  command: z.union([z.string(), packageCommandSchema]),
  args: z.array(z.union([z.string(), stateSchema])),
  env: z.record(z.string(), z.union([z.string(), secretSchema, secretFileSchema, stateSchema])),
});
const httpSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.union([z.string(), secretHeaderSchema])),
  oauth: oauthSchema.optional(),
});
const stdioDefinitionSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: z.literal('stdio'),
  stdio: stdioSchema,
  policy: policySchema,
});
const httpDefinitionSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: z.literal('http'),
  http: httpSchema,
  policy: policySchema,
});
const rawDefinitionSchema = z.discriminatedUnion('transport', [stdioDefinitionSchema, httpDefinitionSchema]);
const definitionSchema = z.discriminatedUnion('transport', [
  stdioDefinitionSchema.extend({
    stdio: stdioSchema.extend({
      command: commandSchema, args: z.array(argumentSchema), env: z.record(z.string(), envValueSchema),
    }),
  }),
  httpDefinitionSchema.extend({
    http: httpSchema.extend({ headers: z.record(z.string(), headerValueSchema) }),
  }),
]);
/** A definition in the broker's grammar: what a create or an update submits. */
export type ProtectedDefinition = z.infer<typeof rawDefinitionSchema>;

/**
 * One connection as the administration sees it. `editable` is the definition
 * an update accepts, with its values tagged. `rawEditable` retains its parsed
 * broker grammar, including optional-field presence, for policy-only writes.
 * Neither representation contains stored secret values. The copies of the
 * definition the broker also puts at the top level are not read.
 */
const connectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http']),
  secrets: z.record(z.string(), z.object({ set: z.boolean() })),
  credential: credentialSchema,
  oauth: z.object({ authorized: z.boolean(), expiresAt: z.number().nullable(), scope: z.string().nullable() }).optional(),
  editable: rawDefinitionSchema,
  runtime: z.enum(['ready', 'installing', 'failed', 'missing']).optional(),
}).transform((view) => ({ ...view, rawEditable: view.editable, editable: definitionSchema.parse(view.editable) }));
export type ProtectedConnectionView = z.infer<typeof connectionViewSchema>;

/** A failed read is its own state, never an empty list. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'failed' }
  | { kind: 'ready'; status: ProtectedMcpStatus };

const directoryHeaders = (directory: string | null): HeadersInit => (directory ? { 'x-opencode-directory': directory } : {});
const query = (directory: string | null) => (directory ? `?directory=${encodeURIComponent(directory)}` : '');

export class ProtectedMcpRequestError extends Error {
  /** The definition field the broker refused, such as `stdio.env.TOKEN`, or null. */
  readonly field: string | null;

  constructor(readonly code: string, message: string, readonly status: number) {
    super(message || code);
    this.name = 'ProtectedMcpRequestError';
    // The broker words a definition error as `<code>: <field>`; other errors carry no field.
    const prefix = `${code}: `;
    this.field = message.startsWith(prefix) && message.length > prefix.length ? message.slice(prefix.length) : null;
  }
}

const errorBodySchema = z.object({ code: z.string(), error: z.string().optional() });

const readError = async (response: Response) => {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new ProtectedMcpRequestError(parsed.data.code, parsed.data.error ?? '', response.status)
    : new ProtectedMcpRequestError(`http_${response.status}`, '', response.status);
};

/** An answer that does not match its contract is a failure, never a partial value. */
const readAnswer = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) throw await readError(response);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ProtectedMcpRequestError('invalid_response', '', response.status);
  return parsed.data;
};

const connectionPath = (id: string) => `/api/protected-mcp/connections/${encodeURIComponent(id)}`;
const sendJson = (method: 'POST' | 'PUT' | 'DELETE', body: string, headers: HeadersInit = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body,
});

const viewAnswerSchema = z.object({ connection: connectionViewSchema });
const deleteAnswerSchema = z.object({ removed: z.literal(true), selectionsNotUpdated: z.array(z.string()) });
const oauthStartSchema = z.object({ attempt: z.string(), authorizationUrl: z.string() });
const oauthAttemptSchema = z.object({ status: z.enum(['pending', 'done', 'unknown']), outcome: z.string().optional() });
const oauthCompleteSchema = z.object({ outcome: z.string(), name: z.string().nullable() });

type Revision = { expectedRevision: number };
/** Typed secret values by slot. They go to the server in this body and nowhere else. */
type SecretValues = Record<string, string>;

export const getProtectedConnection = async (id: string) =>
  (await readAnswer(await runtimeFetch(connectionPath(id)), viewAnswerSchema)).connection;

export const createProtectedConnection = async (
  request: { definition: ProtectedDefinition; secrets: SecretValues; use: { scope: 'global' | 'project' } },
  directory: string | null,
) => (await readAnswer(
  await runtimeFetch(`/api/protected-mcp/connections${query(directory)}`, sendJson('POST', JSON.stringify(request), directoryHeaders(directory))),
  viewAnswerSchema,
)).connection;

export const updateProtectedConnection = async (id: string, request: Revision & { definition: ProtectedDefinition; secrets: SecretValues }) =>
  (await readAnswer(await runtimeFetch(connectionPath(id), sendJson('PUT', JSON.stringify(request))), viewAnswerSchema)).connection;

export const setProtectedConnectionEnabled = async (id: string, request: Revision & { enabled: boolean }) =>
  (await readAnswer(await runtimeFetch(`${connectionPath(id)}/enabled`, sendJson('PUT', JSON.stringify(request))), viewAnswerSchema)).connection;

export const revokeProtectedCredentials = async (id: string, request: Revision) =>
  (await readAnswer(await runtimeFetch(`${connectionPath(id)}/revoke`, sendJson('POST', JSON.stringify(request))), viewAnswerSchema)).connection;

/** Resolves with the selection files that still point at the removed connection. */
export const deleteProtectedConnection = async (id: string, request: Revision) =>
  (await readAnswer(await runtimeFetch(connectionPath(id), sendJson('DELETE', JSON.stringify(request))), deleteAnswerSchema)).selectionsNotUpdated;

export const startProtectedOAuth = async (id: string, request: Revision) =>
  readAnswer(await runtimeFetch(`${connectionPath(id)}/oauth`, sendJson('POST', JSON.stringify(request))), oauthStartSchema);

export const getProtectedOAuthAttempt = async (attempt: string) =>
  readAnswer(await runtimeFetch(`/api/protected-mcp/oauth/attempts/${encodeURIComponent(attempt)}`), oauthAttemptSchema);

/** The paste fallback: the address the sign-in tab ended on. */
export const completeProtectedOAuthFromAddress = async (address: string) =>
  readAnswer(await runtimeFetch('/api/protected-mcp/oauth/complete', sendJson('POST', JSON.stringify({ address }))), oauthCompleteSchema);

/** The status read of the MCP page. Throws only when `signal` aborted it or on a non-Error. */
export const loadProtectedMcpStatus = async (directory: string | null, signal?: AbortSignal): Promise<LoadState> => {
  try {
    const response = await runtimeFetch(`/api/protected-mcp/status${query(directory)}`, { headers: directoryHeaders(directory), signal });
    // VS Code and other hosts without the route answer 501: the feature does not exist there.
    if (response.status === 501 || response.status === 404) return { kind: 'unsupported' };
    if (!response.ok) return { kind: 'failed' };
    const parsed = statusSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ready', status: parsed.data } : { kind: 'failed' };
  } catch (error) {
    if (signal?.aborted || !(error instanceof Error)) throw error;
    return { kind: 'failed' };
  }
};

/** What Settings says about a service that is installed but not usable, or not installed. */
export const PROTECTED_SERVICE_PROBLEM_KEYS = {
  unreachable: 'settings.mcp.protected.service.unreachable',
  permission_denied: 'settings.mcp.protected.service.permissionDenied',
  invalid_response: 'settings.mcp.protected.service.invalid',
  invalid_client_config: 'settings.mcp.protected.service.invalid',
  not_installed: 'settings.mcp.protected.service.notInstalled',
} as const satisfies Record<string, I18nKey>;

type ScopeAvailability = { visible: boolean; disabledReason: I18nKey | null };
const HIDDEN: ScopeAvailability = { visible: false, disabledReason: null };

/**
 * Whether the "Protected" scope is offered when creating a server. Hosts where
 * the service cannot exist hide it; a service that is there but not answering
 * shows it disabled, with the reason.
 */
export const protectedScopeAvailability = (state: LoadState): ScopeAvailability => {
  switch (state.kind) {
    case 'loading':
    case 'unsupported':
      return HIDDEN;
    case 'failed':
      return { visible: true, disabledReason: 'settings.mcp.protected.loadFailed' };
    case 'ready': {
      if (!state.status.host.supported) return HIDDEN;
      const { service } = state.status;
      switch (service.state) {
        case 'available':
          return { visible: true, disabledReason: null };
        case 'not_installed':
        case 'unsupported_platform':
          return HIDDEN;
        case 'unreachable':
        case 'permission_denied':
        case 'invalid_response':
        case 'invalid_client_config':
          return { visible: true, disabledReason: PROTECTED_SERVICE_PROBLEM_KEYS[service.state] };
        default: {
          const unhandled: never = service;
          return unhandled;
        }
      }
    }
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
};

/** A selection change, as the selections route takes it. */
export type ProtectedSelectionRequest = {
  method: 'PUT' | 'DELETE';
  body: { scope: 'global' | 'project'; connection?: string; disabled?: boolean };
};

export const useProtectedMcp = (directory: string | null) => {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });
  const load = React.useCallback(async (signal?: AbortSignal) => {
    try {
      setState(await loadProtectedMcpStatus(directory, signal));
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }, [directory]);

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const change = React.useCallback(async (name: string, request: ProtectedSelectionRequest) => {
    const response = await runtimeFetch(`/api/protected-mcp/selections/${encodeURIComponent(name)}${query(directory)}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(directory) },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) throw await readError(response);
    await load();
  }, [directory, load]);

  return { state, reload: load, change };
};
