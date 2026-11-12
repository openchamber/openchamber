/**
 * Antigravity Provider - API
 *
 * API calls for Antigravity quota provider.
 * @module quota/providers/antigravity/api
 */

import { refreshGoogleAccessToken } from '../google/oauth.js';
import { antigravityHeaders } from './client.js';

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

export const refreshAntigravityToken = async (refreshToken) => {
  const result = await refreshGoogleAccessToken(refreshToken, 'antigravity');
  return result.ok ? result.accessToken : null;
};

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
        return await response.json();
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
        return await response.json();
      }
    } catch {
      continue;
    }
  }

  return null;
};
