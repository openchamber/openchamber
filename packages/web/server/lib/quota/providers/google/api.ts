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

const GOOGLE_PRIMARY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

const GOOGLE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  GOOGLE_PRIMARY_ENDPOINT
];

const GOOGLE_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
};

export const fetchGoogleQuotaBuckets = async (accessToken: string, projectId?: string | null): Promise<JsonValue> => {
  const body = projectId ? { project: projectId } : {};

  try {
    const response = await fetch(`${GOOGLE_PRIMARY_ENDPOINT}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    return isJsonValue(payload) ? payload : null;
  } catch {
    return null;
  }
};

export const fetchGoogleModels = async (accessToken: string, projectId?: string | null): Promise<JsonValue> => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of GOOGLE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...GOOGLE_HEADERS
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
