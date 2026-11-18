
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

export const refreshAntigravityToken = async (refreshToken: string | null) => {
  const result = await refreshGoogleAccessToken(refreshToken, 'antigravity');
  return result.ok ? result.accessToken : null;
};

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
        const payload: unknown = await response.json();
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
        const payload: unknown = await response.json();
        return isJsonValue(payload) ? payload : null;
      }
    } catch {
      continue;
    }
  }

  return null;
};
