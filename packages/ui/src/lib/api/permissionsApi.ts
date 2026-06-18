import { runtimeFetch } from '../runtime-fetch';

export interface Permission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

export const fetchPermissions = async (): Promise<Permission[]> => {
  const response = await runtimeFetch('/api/permission/list');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load permissions'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed)) {
    return [];
  }
  return parsed as Permission[];
};

export const respondToPermission = async (requestId: string, action: 'allow' | 'deny'): Promise<void> => {
  const reply = action === 'allow' ? 'once' : 'reject';
  const response = await runtimeFetch('/api/permission/reply', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ requestID: requestId, reply }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to respond to permission request'));
  }
};

export const fetchPendingPermissions = async (): Promise<Permission[]> => {
  const response = await runtimeFetch('/api/permission/list');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load pending permissions'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed)) {
    return [];
  }
  return parsed as Permission[];
};
