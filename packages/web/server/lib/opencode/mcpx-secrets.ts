import { z } from 'zod';

import { callDaemon } from './mcpx-daemon.js';

// The only shape a secret name takes: an environment variable name.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_VALUE_MAX_LENGTH = 16 * 1024;

// The name, id and value come from a request body or a bridge payload, so each is parsed here.
const secretName = z.string().regex(SECRET_NAME);
const secretRequestId = z.string().regex(SECRET_REQUEST_ID);
const secretValueBody = z.object({
  value: z.string().min(1).max(SECRET_VALUE_MAX_LENGTH),
});

/** What every secret route answers in enterprise mode, from the web server and the VS Code host alike. */
export const MCPX_SECRETS_ENTERPRISE_REFUSAL = {
  error: 'MCP server secrets are not available in enterprise mode.',
  code: 'enterprise_mode',
};

export interface SecretOutcome {
  status: number;
  body: unknown;
}

// Each operation answers with the status and JSON body its route sends. A daemon
// failure is never passed on as its text, since a failed store could repeat the value.
const relay = async (reqPath: string, method?: string): Promise<SecretOutcome> => {
  try {
    return { status: 200, body: await callDaemon(reqPath, method) };
  } catch (error) {
    return { status: 502, body: { error: (error instanceof Error && error.message) || 'mcpx daemon unreachable' } };
  }
};

export const listSecretRequests = () => relay('/v1/secret-requests');

export const listSecrets = () => relay('/v1/secrets');

export const declineSecretRequest = async (id: string | undefined): Promise<SecretOutcome> => {
  const parsed = secretRequestId.safeParse(id);
  if (!parsed.success) {
    return { status: 400, body: { error: 'Invalid secret request id' } };
  }
  return relay(`/v1/secret-requests/${encodeURIComponent(parsed.data)}`, 'DELETE');
};

export const storeSecret = async (name: string | undefined, value: string | undefined): Promise<SecretOutcome> => {
  const parsedName = secretName.safeParse(name);
  if (!parsedName.success) {
    return { status: 400, body: { error: 'A secret name is an environment variable name, such as GITHUB_TOKEN' } };
  }
  const body = secretValueBody.safeParse({ value });
  if (!body.success) {
    return { status: 400, body: { error: `A secret value must be a non-empty string of at most ${SECRET_VALUE_MAX_LENGTH} characters` } };
  }
  try {
    const answer = await callDaemon(`/v1/secrets/${encodeURIComponent(parsedName.data)}`, 'PUT', { value: body.data.value });
    // Only these fields leave, so a daemon reply that echoed the value cannot pass it on.
    const stored: { name?: unknown; set?: unknown; source?: unknown } = answer !== null && typeof answer === 'object' ? answer : {};
    return { status: 200, body: { name: stored.name, set: stored.set, source: stored.source } };
  } catch {
    // The daemon's error text is not forwarded, since it could repeat the value.
    return { status: 502, body: { error: 'mcpx daemon did not store the secret' } };
  }
};
