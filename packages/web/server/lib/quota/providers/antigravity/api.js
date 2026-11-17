/**
 * Antigravity Provider - API
 *
 * API calls for Antigravity quota provider.
 * @module quota/providers/antigravity/api
 */

import { readQuotaJson } from '../../utils/response-body.js';
import { refreshGoogleAccessToken } from '../google/oauth.js';
import { antigravityHeaders } from './client.js';

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

export const refreshAntigravityTokenResult = (refreshToken) => refreshGoogleAccessToken(refreshToken, 'antigravity');

export const refreshAntigravityToken = async (refreshToken) => {
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
export const isWrongClientRejection = (result) => !result.ok
  && result.error === 'unauthorized_client'
  && (result.status === 400 || result.status === 401);

export const fetchAntigravityModels = async (accessToken, projectId) => {
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
        return await readQuotaJson(response);
      }
    } catch {
      continue;
    }
  }

  return null;
};

export const fetchAntigravityQuotaSummary = async (accessToken, projectId) => {
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
        return await readQuotaJson(response);
      }
    } catch {
      continue;
    }
  }

  return null;
};
