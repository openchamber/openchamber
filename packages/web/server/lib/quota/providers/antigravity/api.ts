
import { readQuotaJson } from '../../utils/response-body.js';
import { refreshGoogleAccessToken } from '../google/oauth.js';
import { antigravityHeaders } from './client.js';
import type { JsonValue } from '../../utils/contracts.js';

const isJsonValue = (value: unknown): value is JsonValue => {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (typeof current === 'object') {
      for (const item of Object.values(current)) pending.push(item);
    } else {
      return false;
    }
  }
  return true;
};

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

export const refreshAntigravityTokenResult = (refreshToken: string | null) => refreshGoogleAccessToken(refreshToken, 'antigravity');

export const refreshAntigravityToken = async (refreshToken: string | null) => {
  const result = await refreshAntigravityTokenResult(refreshToken);
  return result.ok ? result.accessToken : null;
};

/**
 * The token endpoint's confirmed "this refresh token was not issued to the
 * Antigravity client" answer: HTTP 400/401 with the OAuth code
 * `unauthorized_client` - the same shape the Google provider's
 * compatibility probe keys on (providers/google/oauth.js). A store login
 * issued by Gemini CLI OAuth produces exactly this, permanently: the
 * credential carries no reliable marker of its issuing client, so this
 * rejection is the first moment the two logins can be told apart. Other
 * failures (invalid_grant, transport, malformed responses) say nothing
 * about which client issued the token.
 */
export const isWrongClientRejection = (result: Awaited<ReturnType<typeof refreshAntigravityTokenResult>>) => !result.ok
  && result.error === 'unauthorized_client'
  && (result.status === 400 || result.status === 401);

export const fetchAntigravityModels = async (accessToken: string, projectId?: string | null): Promise<JsonValue> => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...antigravityHeaders()
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (response.ok) {
        const payload: unknown = await readQuotaJson(response);
        return isJsonValue(payload) ? payload : null;
      }
    } catch {
      continue;
    }
  }

  return null;
};

export const fetchAntigravityQuotaSummary = async (accessToken: string, projectId?: string | null): Promise<JsonValue> => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...antigravityHeaders()
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (response.ok) {
        const payload: unknown = await readQuotaJson(response);
        return isJsonValue(payload) ? payload : null;
      }
    } catch {
      continue;
    }
  }

  return null;
};
